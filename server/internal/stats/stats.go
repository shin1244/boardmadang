// Package stats는 운영자 화면의 방문자 수(DAU, MAU)를 셉니다.
//
// 하루는 한국 시각(KST) 0시부터입니다. GET /api/me를 부른 사람(계정이나 게스트)을 그날 한 번만 셉니다.
// 화면마다 처음에 /api/me를 부르므로 사이트를 연 사람이 다 들어옵니다. 검색 로봇처럼 보이는 요청은 세지 않습니다.
//
// 누가 왔는지는 남기지 않습니다. 계정이나 게스트 번호 대신 서버만 아는 키로 만든 짧은 해시를 남기고,
// MAU(최근 30일)를 세는 데 필요한 30일이 지나면 그날 파일을 지웁니다. 지우기 전에 그날의 수만 따로 남깁니다.
// 게스트로 왔다가 그날 로그인한 사람은 게스트와 계정으로 두 번 셉니다.
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	stats/key                 해시 키. 처음 켤 때 만듭니다
//	stats/visits/<날짜>.log   그날 온 사람마다 한 줄 "m <해시>"(계정) 또는 "g <해시>"(게스트). 30일 동안만
//	stats/days.jsonl          끝난 날의 수 {"day":"2026-11-03","visitors":12,"members":3,"mau":40,"mauMembers":10}
package stats

import (
	"bufio"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

// Window는 MAU를 세는 일 수입니다 (오늘 포함).
const Window = 30

// KST는 하루를 나누는 기준 시간대입니다. 서머타임이 없어 고정 시차로 둡니다 (컨테이너에 시간대 데이터가 없어도 됩니다).
var KST = time.FixedZone("KST", 9*60*60)

// Day는 t의 한국 날짜 "2006-01-02"입니다.
func Day(t time.Time) string { return t.In(KST).Format(time.DateOnly) }

// AddDays는 날짜 day에서 n일 뒤(음수면 앞)의 날짜입니다. day가 날짜 모양이 아니면 그대로 돌려줍니다.
func AddDays(day string, n int) string {
	t, err := time.ParseInLocation(time.DateOnly, day, KST)
	if err != nil {
		return day
	}
	return t.AddDate(0, 0, n).Format(time.DateOnly)
}

// Visits는 하루의 방문 수입니다.
type Visits struct {
	Day        string `json:"day"`
	Visitors   int    `json:"visitors"`   // 그날 온 사람 (계정 + 게스트)
	Members    int    `json:"members"`    // 그중 계정
	MAU        int    `json:"mau"`        // 그날까지 Window일 동안 온 사람
	MAUMembers int    `json:"mauMembers"` // 그중 계정
}

var (
	dayFile = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.log$`)
	// 로봇으로 보고 세지 않는 User-Agent. 화면을 실행해 /api/me까지 부르는 검색 로봇과 미리보기, 자동 검사 도구
	botAgent = regexp.MustCompile(`(?i)bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit`)
)

// Tracker는 날마다 온 사람을 셉니다. 여러 고루틴에서 같이 써도 됩니다.
type Tracker struct {
	dir string
	key []byte
	now func() time.Time // 테스트에서 시간을 바꾸려고 둡니다

	mu     sync.Mutex
	today  string                     // 마지막으로 본 날짜. 바뀌면 끝난 날을 정리합니다 (roll)
	days   map[string]map[string]bool // 날짜 → 해시 → 계정인지. 최근 Window일
	closed map[string]Visits          // 끝난 날의 수 (days.jsonl)
}

// Open은 dir/stats를 읽어 Tracker를 엽니다. 폴더와 키가 없으면 만듭니다.
func Open(dir string) (*Tracker, error) {
	return open(dir, time.Now)
}

func open(dir string, now func() time.Time) (*Tracker, error) {
	t := &Tracker{
		dir:    filepath.Join(dir, "stats"),
		now:    now,
		days:   make(map[string]map[string]bool),
		closed: make(map[string]Visits),
	}
	if err := os.MkdirAll(filepath.Join(t.dir, "visits"), 0o755); err != nil {
		return nil, err
	}
	var err error
	if t.key, err = loadKey(filepath.Join(t.dir, "key")); err != nil {
		return nil, err
	}
	if err := t.loadClosed(); err != nil {
		return nil, err
	}
	if err := t.loadVisits(); err != nil {
		return nil, err
	}
	t.mu.Lock()
	t.roll()
	t.mu.Unlock()
	return t, nil
}

func loadKey(file string) ([]byte, error) {
	key, err := os.ReadFile(file)
	if err == nil && len(key) >= 32 {
		return key, nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, os.WriteFile(file, key, 0o600)
}

func (t *Tracker) loadClosed() error {
	f, err := os.Open(filepath.Join(t.dir, "days.jsonl"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var v Visits
		if json.Unmarshal(sc.Bytes(), &v) == nil && v.Day != "" {
			t.closed[v.Day] = v // 같은 날이 두 번 있으면 나중 것
		}
	}
	return sc.Err()
}

func (t *Tracker) loadVisits() error {
	entries, err := os.ReadDir(filepath.Join(t.dir, "visits"))
	if err != nil {
		return err
	}
	for _, e := range entries {
		m := dayFile.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		data, err := os.ReadFile(filepath.Join(t.dir, "visits", e.Name()))
		if err != nil {
			return err
		}
		set := make(map[string]bool)
		for _, line := range strings.Split(string(data), "\n") {
			kind, h, ok := strings.Cut(strings.TrimSpace(line), " ")
			if ok && h != "" {
				set[h] = set[h] || kind == "m"
			}
		}
		t.days[m[1]] = set
	}
	return nil
}

// roll은 날짜가 바뀌었으면 끝난 날의 수를 days.jsonl에 남기고 Window일이 지난 날 파일을 지웁니다. mu를 잡고 부릅니다.
// 아무도 오지 않은 날도 MAU가 있으므로, 남아 있는 가장 오래된 파일의 날부터 어제까지 하루씩 남깁니다.
func (t *Tracker) roll() {
	today := Day(t.now())
	if today == t.today {
		return
	}
	t.today = today
	// 오래된 날부터 남깁니다. 그날의 MAU는 그 앞 Window-1일의 파일로 세므로 지우기 전에 합니다
	if len(t.days) > 0 {
		for day := slices.Min(slices.Collect(maps.Keys(t.days))); day < today; day = AddDays(day, 1) {
			if _, done := t.closed[day]; done {
				continue
			}
			v := t.count(day)
			t.closed[day] = v
			if err := t.appendLine("days.jsonl", v); err != nil {
				log.Printf("방문 수를 남기지 못했습니다 %s: %v", day, err)
			}
		}
	}
	oldest := AddDays(today, -(Window - 1))
	for day := range t.days {
		if day < oldest {
			delete(t.days, day)
			if err := os.Remove(t.visitFile(day)); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Printf("지난 방문 기록을 지우지 못했습니다 %s: %v", day, err)
			}
		}
	}
}

// count는 남아 있는 파일로 센 그날의 방문 수입니다. mu를 잡고 부릅니다.
func (t *Tracker) count(day string) Visits {
	v := Visits{Day: day}
	for _, member := range t.days[day] {
		v.Visitors++
		if member {
			v.Members++
		}
	}
	from := AddDays(day, -(Window - 1))
	seen := make(map[string]bool)
	for d, set := range t.days {
		if d < from || d > day {
			continue
		}
		for h, member := range set {
			seen[h] = seen[h] || member
		}
	}
	for _, member := range seen {
		v.MAU++
		if member {
			v.MAUMembers++
		}
	}
	return v
}

func (t *Tracker) visitFile(day string) string {
	return filepath.Join(t.dir, "visits", day+".log")
}

func (t *Tracker) appendLine(name string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return appendText(filepath.Join(t.dir, name), string(data)+"\n")
}

func appendText(file, text string) error {
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = f.WriteString(text)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// hash는 사람을 알아볼 수 없는 짧은 해시입니다. 같은 키로는 같은 id가 늘 같은 값이 됩니다.
func (t *Tracker) hash(id string) string {
	mac := hmac.New(sha256.New, t.key)
	mac.Write([]byte(id))
	return hex.EncodeToString(mac.Sum(nil)[:8])
}

// Visit은 GET /api/me를 부른 u를 오늘 온 사람으로 셉니다. identity.Issuer.OnMe에 겁니다.
func (t *Tracker) Visit(r *http.Request, u identity.User) {
	if u.ID == "" || botAgent.MatchString(r.UserAgent()) {
		return
	}
	t.Seen(u.ID, u.IsMember())
}

// Seen은 id를 오늘 온 사람으로 셉니다. 오늘 이미 왔으면 아무것도 하지 않습니다.
func (t *Tracker) Seen(id string, member bool) {
	h := t.hash(id)
	t.mu.Lock()
	defer t.mu.Unlock()
	t.roll()
	set := t.days[t.today]
	if set == nil {
		set = make(map[string]bool)
		t.days[t.today] = set
	}
	if _, ok := set[h]; ok {
		return
	}
	set[h] = member
	kind := "g"
	if member {
		kind = "m"
	}
	if err := appendText(t.visitFile(t.today), fmt.Sprintf("%s %s\n", kind, h)); err != nil {
		log.Printf("방문을 남기지 못했습니다: %v", err)
	}
}

// Range는 오늘까지 n일의 방문 수입니다 (오래된 날부터, 마지막이 오늘). 오늘은 지금까지 온 사람입니다.
// since는 방문을 세기 시작한 날입니다 (그 앞 날은 0이고, 아직 아무도 오지 않았으면 "").
func (t *Tracker) Range(n int) (out []Visits, since string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.roll()
	for _, day := range slices.Concat(slices.Collect(maps.Keys(t.days)), slices.Collect(maps.Keys(t.closed))) {
		if since == "" || day < since {
			since = day
		}
	}
	out = make([]Visits, n)
	for i := range out {
		day := AddDays(t.today, i-(n-1))
		if v, ok := t.closed[day]; ok {
			out[i] = v
		} else if day == t.today {
			out[i] = t.count(day)
		} else {
			out[i] = Visits{Day: day}
		}
	}
	return out, since
}
