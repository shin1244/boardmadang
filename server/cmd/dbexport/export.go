package main

import (
	"bufio"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	_ "modernc.org/sqlite" // 순수 Go라 cgo 없이 빌드됩니다 (Dockerfile의 CGO_ENABLED=0)

	"github.com/shin1244/boardmadang/server/internal/comment"
	"github.com/shin1244/boardmadang/server/internal/protocol"
	"github.com/shin1244/boardmadang/server/internal/record"
	"github.com/shin1244/boardmadang/server/internal/stats"
)

//go:embed schema.sql
var schema string

var (
	dayLog  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.log$`)
	dayJSON = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})\.json$`)
)

// Summary는 표마다 넣은 줄 수와 읽지 못해 건너뛴 파일입니다.
type Summary struct {
	Rows    map[string]int
	Skipped []string // "경로: 이유"
}

// exporter는 DATA_DIR(과 레포의 games/)을 읽어 열린 트랜잭션 하나에 넣습니다.
type exporter struct {
	data, site string
	now        time.Time
	tx         *sql.Tx
	sum        *Summary
}

// Export는 data 폴더의 파일과 site/games/의 게임 목록을 읽어 out에 SQLite 파일을 새로 만듭니다.
// data는 읽기만 합니다. 임시 파일에 다 쓴 뒤 out으로 이름을 바꾸므로, 실패하면 예전 out이 그대로 남습니다.
func Export(data, site, out string, now time.Time) (*Summary, error) {
	if info, err := os.Stat(data); err != nil || !info.IsDir() {
		return nil, fmt.Errorf("데이터 폴더가 없습니다: %s", data)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return nil, err
	}
	tmp := out + ".tmp"
	os.Remove(tmp)
	sum, err := build(data, site, tmp, now)
	if err != nil {
		os.Remove(tmp)
		return nil, err
	}
	if err := os.Rename(tmp, out); err != nil {
		os.Remove(tmp)
		return nil, fmt.Errorf("%s를 바꾸지 못했습니다. 그 파일을 연 프로그램이 있으면 닫고 다시 해 보세요: %w", out, err)
	}
	return sum, nil
}

func build(data, site, file string, now time.Time) (*Summary, error) {
	db, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	// 새로 만드는 파일이라 저널이 필요 없습니다. 실패하면 파일째 버립니다
	if _, err := db.Exec("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF"); err != nil {
		return nil, err
	}
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("스키마: %w", err)
	}
	tx, err := db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	e := &exporter{data: data, site: site, now: now, tx: tx, sum: &Summary{Rows: map[string]int{}}}
	steps := []struct {
		name string
		run  func() error
	}{
		{"게임", e.games},
		{"계정", e.accounts},
		{"대국", e.matches},
		{"의견", e.comments},
		{"즐겨찾기", e.stars},
		{"방문", e.visits},
		{"날마다 방문 수", e.dailyVisits},
		{"AI 대국", e.aiPlays},
		{"코드를 찾지 못한 게임", e.unknownGames},
	}
	for _, s := range steps {
		if err := s.run(); err != nil {
			return nil, fmt.Errorf("%s: %w", s.name, err)
		}
	}
	if err := e.insert("export_info", []string{"key", "value"},
		[]any{"exported_at", kst(now)},
		[]any{"source", "server/cmd/dbexport"},
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	if err := db.Close(); err != nil {
		return nil, err
	}
	return e.sum, nil
}

// insert는 table에 rows를 넣고 넣은 줄 수를 Summary에 셉니다.
func (e *exporter) insert(table string, cols []string, rows ...[]any) error {
	if len(rows) == 0 {
		return nil
	}
	q := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s)", table, strings.Join(cols, ", "),
		strings.TrimSuffix(strings.Repeat("?, ", len(cols)), ", "))
	stmt, err := e.tx.Prepare(q)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, r := range rows {
		if _, err := stmt.Exec(r...); err != nil {
			return fmt.Errorf("%s %v: %w", table, r, err)
		}
	}
	e.sum.Rows[table] += len(rows)
	return nil
}

// skip은 읽지 못한 파일을 남기고 넘어갑니다. 쓰다 멈춘 파일이나 손으로 고친 파일 하나 때문에 전체를 못 만들지 않게 합니다.
func (e *exporter) skip(file string, err error) {
	rel, rerr := filepath.Rel(e.data, file)
	if rerr != nil {
		rel = file
	}
	e.sum.Skipped = append(e.sum.Skipped, fmt.Sprintf("%s: %v", filepath.ToSlash(rel), err))
}

// kst는 시각을 한국 시간 글자로 바꿉니다. 0이면 NULL입니다.
func kst(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.In(stats.KST).Format(time.DateTime)
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// readJSON은 file의 JSON을 v에 읽습니다. 파일이 없으면 false입니다.
func readJSON(file string, v any) (bool, error) {
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(data, v)
}

// eachLine은 file의 줄마다 f를 부릅니다. 파일이 없으면 아무것도 하지 않습니다.
func eachLine(file string, f func(n int, line []byte)) error {
	fh, err := os.Open(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer fh.Close()
	sc := bufio.NewScanner(fh)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for n := 1; sc.Scan(); n++ {
		if len(strings.TrimSpace(sc.Text())) > 0 {
			f(n, sc.Bytes())
		}
	}
	return sc.Err()
}

// dirEntries는 폴더의 항목입니다. 폴더가 없으면 비어 있습니다.
func dirEntries(dir string) ([]os.DirEntry, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return entries, err
}

// listing은 listing.json에서 분석에 쓰는 칸만 읽습니다 (upload.Listing의 일부).
type listing struct {
	Name       map[string]string `json:"name"`
	Difficulty string            `json:"difficulty"`
}

func (l listing) row(id, source string) []any {
	return []any{id, source, nullable(l.Name["ko"]), nullable(l.Name["en"]), nullable(l.Difficulty)}
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// games는 레포의 games/, games/private/과 DATA_DIR/uploads/의 게임입니다.
func (e *exporter) games() error {
	cols := []string{"id", "source", "name_ko", "name_en", "difficulty"}
	var rows [][]any
	for _, base := range []struct{ dir, source string }{{"games", "repo"}, {"games/private", "private"}} {
		dir := filepath.Join(e.site, filepath.FromSlash(base.dir))
		entries, err := dirEntries(dir)
		if err != nil {
			return err
		}
		for _, d := range entries {
			if !d.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(dir, d.Name(), "index.js")); err != nil {
				continue // 게임 폴더가 아님 (games/private 자체 등)
			}
			var l listing
			if _, err := readJSON(filepath.Join(dir, d.Name(), "listing.json"), &l); err != nil {
				e.skip(filepath.Join(dir, d.Name(), "listing.json"), err)
			}
			rows = append(rows, l.row(d.Name(), base.source))
		}
	}
	if err := e.insert("games", cols, rows...); err != nil {
		return err
	}

	// 올린 게임 (upload.gameMeta의 일부)
	type uploaded struct {
		ID        string    `json:"id"`
		Owner     string    `json:"owner"`
		Version   string    `json:"version"`
		Listing   listing   `json:"listing"`
		Created   time.Time `json:"created"`
		Published []struct {
			Version string    `json:"version"`
			At      time.Time `json:"at"`
		} `json:"published"`
		Hidden  bool `json:"hidden"`
		Blocked bool `json:"blocked"`
	}
	dir := filepath.Join(e.data, "uploads")
	entries, err := dirEntries(dir)
	if err != nil {
		return err
	}
	var games, releases [][]any
	for _, d := range entries {
		if !d.IsDir() {
			continue
		}
		file := filepath.Join(dir, d.Name(), "game.json")
		var g uploaded
		ok, err := readJSON(file, &g)
		if err == nil && ok && g.ID != d.Name() {
			err = fmt.Errorf("id %q가 폴더 이름과 다릅니다", g.ID)
		}
		if err != nil {
			e.skip(file, err)
			continue
		}
		if !ok {
			continue // 등록하다 멈춘 폴더
		}
		games = append(games, append(g.Listing.row(g.ID, "upload"),
			g.Owner, g.Version, kst(g.Created), boolInt(g.Hidden), boolInt(g.Blocked)))
		for _, p := range g.Published {
			releases = append(releases, []any{g.ID, p.Version, kst(p.At)})
		}
	}
	// 레포 게임과 id가 같을 일은 없지만(서버가 막음), 있으면 올린 게임으로 둡니다
	for _, g := range games {
		if _, err := e.tx.Exec("DELETE FROM games WHERE id = ?", g[0]); err != nil {
			return err
		}
	}
	if err := e.insert("games", append(cols, "owner_id", "version", "created_at", "hidden", "blocked"), games...); err != nil {
		return err
	}
	return e.insert("game_releases", []string{"game_id", "version", "published_at"}, releases...)
}

// unknownGames는 대국, 의견, 즐겨찾기, AI 대국에만 나오는 게임(지운 레포 게임 등)을 games에 넣어 JOIN이 빠뜨리지 않게 합니다.
func (e *exporter) unknownGames() error {
	res, err := e.tx.Exec(`INSERT INTO games (id, source)
		SELECT game_id, 'unknown' FROM (
			SELECT game_id FROM matches UNION SELECT game_id FROM comments
			UNION SELECT game_id FROM stars UNION SELECT game_id FROM ai_plays
		) WHERE game_id NOT IN (SELECT id FROM games)`)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		e.sum.Rows["games"] += int(n)
	}
	return nil
}

// accounts는 accounts.jsonl을 처음부터 다시 적용해 지금 계정을 만듭니다 (account.Open과 같은 방법).
// 로그인한 곳의 사용자 번호(sub)는 분석에 필요 없어 읽지 않습니다.
func (e *exporter) accounts() error {
	type account struct {
		id, provider, name string
		created, renamed   time.Time
		suspended          bool
		suspendedUntil     time.Time
	}
	type line struct {
		Op       string    `json:"op"` // add, rename, suspend, unsuspend
		ID       string    `json:"id"`
		Provider string    `json:"provider"`
		Name     string    `json:"name"`
		Until    time.Time `json:"until"`
		At       time.Time `json:"at"`
	}
	file := filepath.Join(e.data, "accounts.jsonl")
	var order []string
	byID := map[string]*account{}
	err := eachLine(file, func(n int, data []byte) {
		var l line
		if err := json.Unmarshal(data, &l); err != nil {
			e.skip(file, fmt.Errorf("%d번째 줄: %w", n, err))
			return
		}
		a := byID[l.ID]
		switch l.Op {
		case "add":
			if a == nil {
				order = append(order, l.ID)
			}
			byID[l.ID] = &account{id: l.ID, provider: l.Provider, name: l.Name, created: l.At}
		case "rename":
			if a != nil {
				a.name, a.renamed = l.Name, l.At
			}
		case "suspend":
			if a != nil {
				a.suspended, a.suspendedUntil = true, l.Until
			}
		case "unsuspend":
			if a != nil {
				a.suspended, a.suspendedUntil = false, time.Time{}
			}
		}
	})
	if err != nil {
		return err
	}
	rows := make([][]any, 0, len(order))
	for _, id := range order {
		a := byID[id]
		suspended := a.suspended && (a.suspendedUntil.IsZero() || e.now.Before(a.suspendedUntil)) // account.SuspendedAt
		rows = append(rows, []any{a.id, a.provider, a.name, kst(a.created), stats.Day(a.created), kst(a.renamed), boolInt(suspended)})
	}
	return e.insert("accounts", []string{"id", "provider", "name", "created_at", "created_day", "renamed_at", "suspended"}, rows...)
}

// counted는 record.counts와 같은 기준입니다: 무효, 행동 없음, 한 사람이 두 자리에 앉은 대국은 세지 않습니다.
func counted(m *record.Match) bool {
	switch m.Reason {
	case protocol.ReasonDesync, protocol.ReasonDisagree, protocol.ReasonLimit:
		return false
	}
	return len(m.Moves) > 0 && m.Players[0].ID != m.Players[1].ID
}

// matches는 matches/<앞 두 글자>/<id>.json을 모두 읽습니다.
func (e *exporter) matches() error {
	root := filepath.Join(e.data, "matches")
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if errors.Is(err, os.ErrNotExist) && p == root {
			return fs.SkipDir
		}
		if err != nil {
			return err
		}
		if !d.IsDir() && strings.HasSuffix(p, ".json") { // 쓰는 중인 .tmp는 건너뜁니다
			files = append(files, p)
		}
		return nil
	})
	if err != nil {
		return err
	}
	slices.Sort(files)
	var matches, players, actions [][]any
	for _, file := range files {
		m := new(record.Match)
		if _, err := readJSON(file, m); err != nil {
			e.skip(file, err)
			continue
		}
		if !record.ValidID(m.ID) || m.Game == "" || m.Ended.IsZero() {
			e.skip(file, errors.New("기보 모양이 아닙니다"))
			continue
		}
		var duration, left0, left1 any
		if !m.Started.IsZero() {
			duration = m.Ended.Sub(m.Started).Seconds()
		}
		if m.Clock != nil {
			left0, left1 = m.Clock[0], m.Clock[1]
		}
		matches = append(matches, []any{
			m.ID, m.Game, nullable(m.Version), m.Minutes, kst(m.Started), kst(m.Ended), stats.Day(m.Ended), duration,
			len(m.Moves), m.Reason, m.Winner, boolInt(counted(m)), left0, left1,
		})
		for seat, p := range m.Players {
			players = append(players, []any{m.ID, seat, p.ID, p.Kind, nullable(p.Name)})
		}
		for seq, a := range m.Moves {
			actions = append(actions, []any{m.ID, seq, a.Player, a.Action.Kind, a.Action.Row, a.Action.Col, a.At})
		}
	}
	if err := e.insert("matches", []string{"id", "game_id", "version", "timer_minutes", "started_at", "ended_at", "day",
		"duration_sec", "actions", "reason", "winner", "counted", "clock_left0_ms", "clock_left1_ms"}, matches...); err != nil {
		return err
	}
	if err := e.insert("match_players", []string{"match_id", "seat", "player_id", "kind", "name"}, players...); err != nil {
		return err
	}
	return e.insert("match_actions", []string{"match_id", "seq", "seat", "kind", "row", "col", "at_ms"}, actions...)
}

// comments는 comments/<게임>.jsonl을 처음부터 다시 적용합니다 (comment 패키지의 thread.apply와 같은 방법).
func (e *exporter) comments() error {
	type entry struct {
		id, author, kind, text string
		at                     time.Time
		deleted                bool
		reporters              map[string]bool
		mod                    string
	}
	type line struct {
		Op   string    `json:"op"`
		ID   string    `json:"id"`
		By   string    `json:"by"`
		Kind string    `json:"kind"`
		Text string    `json:"text"`
		Mod  string    `json:"mod"`
		At   time.Time `json:"at"`
	}
	dir := filepath.Join(e.data, "comments")
	files, err := dirEntries(dir)
	if err != nil {
		return err
	}
	var rows [][]any
	for _, f := range files {
		game, ok := strings.CutSuffix(f.Name(), ".jsonl")
		if f.IsDir() || !ok {
			continue
		}
		file := filepath.Join(dir, f.Name())
		var list []*entry
		byID := map[string]*entry{}
		err := eachLine(file, func(n int, data []byte) {
			var l line
			if err := json.Unmarshal(data, &l); err != nil {
				e.skip(file, fmt.Errorf("%d번째 줄: %w", n, err))
				return
			}
			c := byID[l.ID]
			switch l.Op {
			case "add":
				c = &entry{id: l.ID, author: l.By, kind: l.Kind, text: l.Text, at: l.At, reporters: map[string]bool{}}
				list = append(list, c)
				byID[l.ID] = c
			case "del":
				if c != nil {
					c.deleted = true
				}
			case "report":
				if c != nil {
					c.reporters[l.By] = true
				}
			case "mod":
				if c != nil {
					c.mod = l.Mod
				}
			}
		})
		if err != nil {
			return err
		}
		for _, c := range list {
			var text any = c.text
			if c.deleted {
				text = nil // 쓴 사람이 지운 글은 분석에도 넣지 않습니다
			}
			hidden := c.mod == comment.ModHidden || (c.mod != comment.ModShown && len(c.reporters) >= comment.HideAfter)
			rows = append(rows, []any{game, c.id, c.author, c.kind, kst(c.at), stats.Day(c.at), text,
				boolInt(c.deleted), len(c.reporters), boolInt(hidden)})
		}
	}
	return e.insert("comments", []string{"game_id", "id", "author_id", "author_kind", "created_at", "day", "text",
		"deleted", "reporters", "hidden"}, rows...)
}

// stars는 stars.json입니다 {"<게임>":["m_…",…]}.
func (e *exporter) stars() error {
	file := filepath.Join(e.data, "stars.json")
	var saved map[string][]string
	if _, err := readJSON(file, &saved); err != nil {
		e.skip(file, err)
		return nil
	}
	var rows [][]any
	for _, game := range slices.Sorted(maps.Keys(saved)) {
		seen := map[string]bool{}
		for _, id := range saved[game] {
			if !seen[id] {
				seen[id] = true
				rows = append(rows, []any{game, id})
			}
		}
	}
	return e.insert("stars", []string{"game_id", "account_id"}, rows...)
}

// visits는 stats/visits/<날짜>.log입니다. 한 줄에 "m <해시>"(계정) 또는 "g <해시>"(게스트).
func (e *exporter) visits() error {
	dir := filepath.Join(e.data, "stats", "visits")
	files, err := dirEntries(dir)
	if err != nil {
		return err
	}
	var rows [][]any
	for _, f := range files {
		m := dayLog.FindStringSubmatch(f.Name())
		if m == nil {
			continue
		}
		member := map[string]bool{}
		var order []string
		err := eachLine(filepath.Join(dir, f.Name()), func(_ int, data []byte) {
			kind, h, ok := strings.Cut(strings.TrimSpace(string(data)), " ")
			if !ok || h == "" {
				return
			}
			if _, seen := member[h]; !seen {
				order = append(order, h)
			}
			member[h] = member[h] || kind == "m"
		})
		if err != nil {
			return err
		}
		for _, h := range order {
			rows = append(rows, []any{m[1], h, boolInt(member[h])})
		}
	}
	return e.insert("visits", []string{"day", "visitor", "member"}, rows...)
}

// dailyVisits는 stats/days.jsonl입니다. 한 날이 두 번 있으면 나중 줄을 씁니다.
func (e *exporter) dailyVisits() error {
	file := filepath.Join(e.data, "stats", "days.jsonl")
	byDay := map[string][]any{}
	err := eachLine(file, func(n int, data []byte) {
		var v stats.Visits
		if err := json.Unmarshal(data, &v); err != nil || v.Day == "" {
			if err == nil {
				err = errors.New("날짜가 없습니다")
			}
			e.skip(file, fmt.Errorf("%d번째 줄: %w", n, err))
			return
		}
		byDay[v.Day] = []any{v.Day, v.Visitors, v.Members, v.MAU, v.MAUMembers}
	})
	if err != nil {
		return err
	}
	rows := make([][]any, 0, len(byDay))
	for _, day := range slices.Sorted(maps.Keys(byDay)) {
		rows = append(rows, byDay[day])
	}
	return e.insert("daily_visits", []string{"day", "visitors", "members", "mau", "mau_members"}, rows...)
}

// aiPlays는 stats/ai/<날짜>.json입니다 {"<게임>": stats.AICount}.
func (e *exporter) aiPlays() error {
	dir := filepath.Join(e.data, "stats", "ai")
	files, err := dirEntries(dir)
	if err != nil {
		return err
	}
	var rows [][]any
	for _, f := range files {
		m := dayJSON.FindStringSubmatch(f.Name())
		if m == nil {
			continue
		}
		file := filepath.Join(dir, f.Name())
		var games map[string]stats.AICount
		if _, err := readJSON(file, &games); err != nil {
			e.skip(file, err)
			continue
		}
		for _, game := range slices.Sorted(maps.Keys(games)) {
			c := games[game]
			rows = append(rows, []any{m[1], game, c.Plays, c.Ends, c.Wins, c.Draws})
		}
	}
	return e.insert("ai_plays", []string{"day", "game_id", "plays", "ends", "wins", "draws"}, rows...)
}
