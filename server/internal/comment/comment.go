// Package comment는 게임마다 남기는 의견과 신고입니다.
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	comments/<게임 id>.jsonl   그 게임의 의견 기록. 남김(add), 지움(del), 신고(report)를 한 줄에 하나씩 덧붙입니다
//	reports.jsonl              모든 신고 (의견과 게임). 운영자가 보는 용도입니다
//
// 게임마다 처음 부를 때 파일을 처음부터 읽어 메모리에 올려 둡니다. 서버 한 대(VM 디스크)를 전제로 합니다.
//
// 서로 다른 사람 HideAfter명이 신고한 의견은 글을 가립니다. 지금은 게스트도 의견을 남기고 신고할 수 있어서,
// 쿠키를 지워 가며 한 사람이 여러 번 신고할 수 있습니다. 계정이 생기면 계정만 받거나 계정의 신고를 더 무겁게 셉니다.
// TODO: IP별 제한, 운영자 화면에서 신고를 보고 가리거나 되살리기
package comment

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/protocol"
)

const (
	MaxText        = 500 // 의견 한 개의 글자 수
	MaxLines       = 20  // 의견 한 개의 줄 수
	MaxDetail      = 300 // 신고에 덧붙이는 설명의 글자 수
	HideAfter      = 3   // 이만큼의 사람이 신고하면 글을 가립니다
	ListLimit      = 100 // 한 번에 보여줄 의견 수 (최근 것부터)
	PostEvery      = 15 * time.Second
	ReportsPerHour = 20 // 한 사람이 한 시간에 할 수 있는 신고 수
)

// Reasons는 신고 사유입니다. 의견에는 spam, abuse, adult, other를, 게임에는 전부를 씁니다.
var Reasons = map[string]bool{"spam": true, "abuse": true, "adult": true, "copyright": true, "broken": true, "other": true}

var (
	ErrBadGame   = errors.New("bad game")
	ErrEmpty     = errors.New("empty")
	ErrTooLong   = errors.New("too long")
	ErrTooSoon   = errors.New("too soon")
	ErrNotFound  = errors.New("not found")
	ErrNotYours  = errors.New("not yours")
	ErrOwn       = errors.New("own comment")
	ErrBadReason = errors.New("bad reason")
	ErrTooMany   = errors.New("too many reports")
)

var (
	gamePattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	idPattern   = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{8}$`)
)

const idAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}

// Comment는 의견 하나입니다.
type Comment struct {
	ID        string
	Author    identity.User
	Text      string
	At        time.Time
	deleted   bool
	reporters map[string]bool
}

func (c *Comment) hidden() bool { return len(c.reporters) >= HideAfter }

// View는 브라우저에 보내는 의견입니다. 쓴 사람의 내부 id는 빼고, 보는 사람과의 관계를 붙입니다.
// 가려진 의견은 글을 보내지 않습니다.
type View struct {
	ID       string              `json:"id"`
	Author   protocol.PlayerInfo `json:"author"`
	Text     string              `json:"text,omitempty"`
	At       time.Time           `json:"at"`
	Mine     bool                `json:"mine,omitempty"`
	Reported bool                `json:"reported,omitempty"` // 보는 사람이 이미 신고함
	Hidden   bool                `json:"hidden,omitempty"`
}

func (c *Comment) view(viewer string) View {
	v := View{
		ID:       c.ID,
		Author:   protocol.PlayerInfo{Kind: c.Author.Kind, Tag: c.Author.Tag, Name: c.Author.Name},
		At:       c.At,
		Mine:     viewer != "" && c.Author.ID == viewer,
		Reported: viewer != "" && c.reporters[viewer],
		Hidden:   c.hidden(),
	}
	if !v.Hidden {
		v.Text = c.Text
	}
	return v
}

// Report는 신고 하나입니다. Comment가 비었으면 게임을 신고한 것입니다.
type Report struct {
	At      time.Time `json:"at"`
	Game    string    `json:"game"`
	Comment string    `json:"comment,omitempty"`
	By      string    `json:"by"`
	Reason  string    `json:"reason"`
	Detail  string    `json:"detail,omitempty"`
}

// line은 comments/<게임>.jsonl의 한 줄입니다.
type line struct {
	Op   string    `json:"op"` // add, del, report
	ID   string    `json:"id"`
	By   string    `json:"by,omitempty"`
	Kind string    `json:"kind,omitempty"`
	Tag  string    `json:"tag,omitempty"`
	Name string    `json:"name,omitempty"`
	Text string    `json:"text,omitempty"`
	At   time.Time `json:"at"`
}

type thread struct {
	list []*Comment // 남긴 순서
	byID map[string]*Comment
}

type Store struct {
	dir string
	now func() time.Time // 테스트에서 시간을 바꾸려고 둡니다

	mu          sync.Mutex
	threads     map[string]*thread
	gameReports map[string]map[string]bool // 게임 → 신고한 사람
	lastPost    map[string]time.Time
	reportTimes map[string][]time.Time // 사람 → 최근 한 시간의 신고 시각
}

// Open은 dir 아래에 의견과 신고를 저장하는 Store를 엽니다. 폴더가 없으면 만듭니다.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "comments"), 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		dir:         dir,
		now:         time.Now,
		threads:     make(map[string]*thread),
		gameReports: make(map[string]map[string]bool),
		lastPost:    make(map[string]time.Time),
		reportTimes: make(map[string][]time.Time),
	}
	// 같은 사람이 같은 게임을 두 번 신고하지 않게, 지난 게임 신고를 읽어 둡니다
	err := eachLine(filepath.Join(dir, "reports.jsonl"), func(data []byte) {
		var r Report
		if json.Unmarshal(data, &r) == nil && r.Comment == "" {
			s.markGameReport(r.Game, r.By)
		}
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) markGameReport(game, by string) {
	if s.gameReports[game] == nil {
		s.gameReports[game] = make(map[string]bool)
	}
	s.gameReports[game][by] = true
}

// eachLine은 파일의 줄마다 f를 부릅니다. 파일이 없으면 아무것도 하지 않습니다.
func eachLine(file string, f func([]byte)) error {
	fh, err := os.Open(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	for sc.Scan() {
		f(sc.Bytes())
	}
	return sc.Err()
}

func appendJSON(file string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	fh, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, err = fh.Write(append(data, '\n'))
	if cerr := fh.Close(); err == nil {
		err = cerr
	}
	return err
}

func (s *Store) file(game string) string { return filepath.Join(s.dir, "comments", game+".jsonl") }

// thread는 게임의 의견을 메모리에서 찾고, 없으면 파일에서 읽어 옵니다. s.mu를 잡고 부릅니다.
func (s *Store) thread(game string) (*thread, error) {
	if !gamePattern.MatchString(game) {
		return nil, ErrBadGame
	}
	if t := s.threads[game]; t != nil {
		return t, nil
	}
	t := &thread{byID: make(map[string]*Comment)}
	err := eachLine(s.file(game), func(data []byte) {
		var l line
		if err := json.Unmarshal(data, &l); err != nil {
			log.Printf("의견 기록의 깨진 줄 (%s): %v", game, err)
			return
		}
		t.apply(l)
	})
	if err != nil {
		return nil, err
	}
	s.threads[game] = t
	return t, nil
}

func (t *thread) apply(l line) {
	switch l.Op {
	case "add":
		c := &Comment{
			ID:        l.ID,
			Author:    identity.User{ID: l.By, Kind: l.Kind, Tag: l.Tag, Name: l.Name},
			Text:      l.Text,
			At:        l.At,
			reporters: make(map[string]bool),
		}
		t.list = append(t.list, c)
		t.byID[c.ID] = c
	case "del":
		if c := t.byID[l.ID]; c != nil {
			c.deleted = true
		}
	case "report":
		if c := t.byID[l.ID]; c != nil {
			c.reporters[l.By] = true
		}
	}
}

// write는 한 줄을 파일에 덧붙이고 메모리에도 적용합니다. 파일에 못 쓰면 메모리도 그대로 둡니다. s.mu를 잡고 부릅니다.
func (s *Store) write(game string, t *thread, l line) error {
	if err := appendJSON(s.file(game), l); err != nil {
		return err
	}
	t.apply(l)
	return nil
}

// List는 게임의 의견을 최근 것부터 ListLimit개, 그리고 지우지 않은 의견의 수를 돌려줍니다.
func (s *Store) List(game, viewer string) ([]View, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.thread(game)
	if err != nil {
		return nil, 0, err
	}
	out := []View{}
	count := 0
	for i := len(t.list) - 1; i >= 0; i-- {
		c := t.list[i]
		if c.deleted {
			continue
		}
		count++
		if len(out) < ListLimit {
			out = append(out, c.view(viewer))
		}
	}
	return out, count, nil
}

// Clean은 글을 다듬습니다. 앞뒤 공백을 지우고, 줄바꿈 말고는 제어 문자를 뺍니다. 길이는 보지 않습니다.
func Clean(text string) string {
	text = strings.ToValidUTF8(text, "")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.Map(func(r rune) rune {
		switch {
		case r == '\n':
			return r
		case r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, text)
	return strings.TrimSpace(text)
}

// Post는 u가 게임에 의견을 남깁니다. 한 사람은 PostEvery에 한 번 남길 수 있습니다.
func (s *Store) Post(game string, u identity.User, text string) (View, error) {
	text = Clean(text)
	if text == "" {
		return View{}, ErrEmpty
	}
	if utf8.RuneCountInString(text) > MaxText || strings.Count(text, "\n") >= MaxLines {
		return View{}, ErrTooLong
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.thread(game)
	if err != nil {
		return View{}, err
	}
	now := s.now()
	if now.Sub(s.lastPost[u.ID]) < PostEvery {
		return View{}, ErrTooSoon
	}
	l := line{Op: "add", ID: newID(), By: u.ID, Kind: u.Kind, Tag: u.Tag, Name: u.Name, Text: text, At: now}
	if err := s.write(game, t, l); err != nil {
		return View{}, err
	}
	s.lastPost[u.ID] = now
	if len(s.lastPost) > 10_000 {
		for id, at := range s.lastPost {
			if now.Sub(at) >= PostEvery {
				delete(s.lastPost, id)
			}
		}
	}
	return t.byID[l.ID].view(u.ID), nil
}

// Delete는 u가 자기 의견을 지웁니다.
func (s *Store) Delete(game, id string, u identity.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.thread(game)
	if err != nil {
		return err
	}
	c := t.byID[id]
	if c == nil || c.deleted {
		return ErrNotFound
	}
	if c.Author.ID != u.ID {
		return ErrNotYours
	}
	return s.write(game, t, line{Op: "del", ID: id, At: s.now()})
}

// Report는 u의 신고를 받습니다. r.Comment가 비었으면 게임 신고입니다.
// 같은 것을 두 번 신고하면 그냥 받은 것으로 칩니다. hidden은 그 의견이 이제 가려졌는지입니다.
func (s *Store) Report(u identity.User, r Report) (hidden bool, err error) {
	if !Reasons[r.Reason] {
		return false, ErrBadReason
	}
	r.Detail = Clean(r.Detail)
	if utf8.RuneCountInString(r.Detail) > MaxDetail {
		return false, ErrTooLong
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	t, err := s.thread(r.Game)
	if err != nil {
		return false, err
	}
	var c *Comment
	if r.Comment != "" {
		if c = t.byID[r.Comment]; !idPattern.MatchString(r.Comment) || c == nil || c.deleted {
			return false, ErrNotFound
		}
		if c.Author.ID == u.ID {
			return false, ErrOwn
		}
		if c.reporters[u.ID] {
			return c.hidden(), nil
		}
	} else if s.gameReports[r.Game][u.ID] {
		return false, nil
	}

	now := s.now()
	var recent []time.Time
	for _, at := range s.reportTimes[u.ID] {
		if now.Sub(at) < time.Hour {
			recent = append(recent, at)
		}
	}
	if len(recent) >= ReportsPerHour {
		s.reportTimes[u.ID] = recent
		return false, ErrTooMany
	}

	r.At, r.By = now, u.ID
	if err := appendJSON(filepath.Join(s.dir, "reports.jsonl"), r); err != nil {
		return false, err
	}
	s.reportTimes[u.ID] = append(recent, now)
	if c == nil {
		s.markGameReport(r.Game, u.ID)
		return false, nil
	}
	if err := s.write(r.Game, t, line{Op: "report", ID: c.ID, By: u.ID, At: now}); err != nil {
		return false, err
	}
	return c.hidden(), nil
}
