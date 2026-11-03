// Package admin은 운영자 화면(/web/admin.html)의 API입니다. 설계는 docs/moderation.md에 있습니다.
//
//	GET  /api/admin           신고를 대상(게임이나 의견)별로 묶은 목록, 정지된 계정, 최근 운영 기록 (State)
//	POST /api/admin/actions   운영 조치 하나 (Action) → 200 {"ok":true}
//
// 운영자(ADMIN_IDS, identity.User.Admin)만 됩니다. 아니면 쿠키가 없을 때 401, 있으면 403 {"error":"admin only"}.
// POST는 JSON 본문만 받습니다 (다른 사이트의 폼은 이런 본문을 보낼 수 없고, fetch는 미리 확인에서 막힙니다).
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	admin.jsonl   운영 기록. 조치 하나를 한 줄에 하나씩 덧붙입니다 (누가, 언제, 무엇을)
//
// 신고 자체는 internal/comment가 reports.jsonl에 남깁니다. 대상마다 마지막 조치보다 늦게 온 신고가 있으면 "새 신고"로 봅니다.
// 그래서 따로 "처리함" 표시를 저장하지 않고, 바꿀 것이 없을 때도 dismiss 조치를 남겨 처리한 것으로 칩니다.
package admin

import (
	"bufio"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/comment"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

const (
	MaxNote      = 300 // 조치에 남기는 메모의 글자 수
	LogLimit     = 100 // State에 보내는 최근 운영 기록 수
	ClosedLimit  = 50  // State에 보내는 처리한 대상 수 (새 신고가 있는 대상은 모두)
	maxBody      = 4 << 10
	suspendLimit = 30 // 기간을 정한 정지의 최대 일 수 (그보다 길면 영구)
)

// 조치
const (
	CommentHide   = "comment.hide"   // 의견을 가림 (신고 수와 상관없이)
	CommentShow   = "comment.show"   // 의견을 보이게 함 (신고가 쌓여도)
	GameBlock     = "game.block"     // 올린 게임을 내림. 주인이 다시 올릴 수 없음
	GameUnblock   = "game.unblock"   // 내린 게임을 되살림
	UserSuspend   = "user.suspend"   // 계정 정지 (Days일, 0이면 영구)
	UserUnsuspend = "user.unsuspend" // 정지 풀기
	Dismiss       = "dismiss"        // 바꿀 것 없이 신고를 처리한 것으로
)

// SuspendDays는 고를 수 있는 정지 기간입니다 (0은 영구).
var SuspendDays = []int{1, 7, suspendLimit, 0}

var (
	gamePattern    = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	commentPattern = regexp.MustCompile(`^[A-HJ-NP-Z2-9]{8}$`)
)

// Action은 POST /api/admin/actions의 본문이자 admin.jsonl의 한 줄입니다.
// 정지와 풀기에도 Game, Comment를 넣으면 그 대상의 신고를 처리한 것으로 칩니다 (신고를 보고 쓴 사람을 정지할 때).
type Action struct {
	Action  string    `json:"action"`
	Game    string    `json:"game,omitempty"`
	Comment string    `json:"comment,omitempty"`
	User    string    `json:"user,omitempty"`
	Days    int       `json:"days,omitempty"` // user.suspend만
	Note    string    `json:"note,omitempty"`
	By      string    `json:"by,omitempty"`   // 운영자 계정 id. 서버가 채웁니다
	At      time.Time `json:"at"`             // 서버가 채웁니다
	Until   time.Time `json:"until,omitzero"` // user.suspend만. 서버가 채웁니다 (영구면 없음)
}

func (a Action) target() string { return a.Game + "/" + a.Comment }

// Handler는 운영자 API입니다. Open으로 엽니다.
type Handler struct {
	IDs      *identity.Issuer
	Comments *comment.Store
	Uploads  *upload.Store
	Accounts *account.Store

	file string
	now  func() time.Time // 테스트에서 시간을 바꾸려고 둡니다

	mu      sync.Mutex
	actions []Action // 운영 기록. 남긴 순서
}

// Open은 dir/admin.jsonl을 읽어 Handler를 엽니다. 저장소는 부르는 쪽이 채웁니다.
func Open(dir string) (*Handler, error) {
	h := &Handler{file: filepath.Join(dir, "admin.jsonl"), now: time.Now}
	f, err := os.Open(h.file)
	if errors.Is(err, os.ErrNotExist) {
		return h, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var a Action
		if json.Unmarshal(sc.Bytes(), &a) == nil {
			h.actions = append(h.actions, a)
		}
	}
	return h, sc.Err()
}

// ---- 화면에 보내는 모양 ----

// State는 GET /api/admin의 응답입니다.
type State struct {
	Targets   []Target        `json:"targets"`   // 새 신고가 있는 대상 먼저, 그다음 처리한 대상. 각각 마지막 신고가 최근인 것부터
	Users     map[string]User `json:"users"`     // Targets, Suspended, Log에 나오는 계정
	Suspended []string        `json:"suspended"` // 지금 정지된 계정 id. 풀리는 때가 가까운 것부터, 영구는 맨 뒤
	Log       []Action        `json:"log"`       // 최근 운영 기록, 최근 것부터
	Days      []int           `json:"days"`      // 고를 수 있는 정지 기간 (0은 영구)
}

// Target은 신고를 받은 게임이나 의견 하나와 그 신고들입니다.
type Target struct {
	Game    string           `json:"game"`
	Comment string           `json:"comment,omitempty"` // 비었으면 게임 신고
	Open    bool             `json:"open"`              // 마지막 조치보다 늦게 온 신고가 있음
	Latest  time.Time        `json:"latest"`            // 마지막 신고
	Reports []comment.Report `json:"reports"`           // 최근 것부터. By는 신고한 계정 id (Users에서 찾음)
	// 의견이면 그 의견 (탈퇴로 지워졌으면 없음), 올린 게임이면 그 게임 (레포 게임이면 없음)
	CommentInfo *comment.Info     `json:"commentInfo,omitempty"`
	GameInfo    *upload.AdminGame `json:"gameInfo,omitempty"`
	LastAction  *Action           `json:"lastAction,omitempty"`
}

// User는 운영자 화면에 보이는 계정입니다.
type User struct {
	ID             string    `json:"id"`
	Name           string    `json:"name,omitempty"`
	Tag            string    `json:"tag,omitempty"`
	Guest          bool      `json:"guest,omitempty"` // 계정이 아닌 게스트 (계정만 쓰게 되기 전에 남긴 것). 정지할 수 없음
	Gone           bool      `json:"gone,omitempty"`  // 탈퇴한 계정
	Admin          bool      `json:"admin,omitempty"`
	Suspended      bool      `json:"suspended,omitempty"`
	SuspendedUntil time.Time `json:"suspendedUntil,omitzero"` // 영구면 없음
}

func (h *Handler) user(id string) User {
	if !strings.HasPrefix(id, "m_") {
		return User{ID: id, Guest: true}
	}
	a, ok := h.Accounts.Get(id)
	if !ok {
		return User{ID: id, Gone: true}
	}
	m := identity.Member(a.ID, a.Name)
	u := User{ID: id, Name: a.Name, Tag: m.Tag, Admin: h.IDs.Admins[id]}
	u.SuspendedUntil, u.Suspended = h.Accounts.Suspension(id)
	return u
}

// State는 지금 운영자 화면에 보일 것입니다.
func (h *Handler) State() (State, error) {
	reports, err := h.Comments.Reports()
	if err != nil {
		return State{}, err
	}
	h.mu.Lock()
	last := make(map[string]Action) // 대상 → 마지막 조치
	for _, a := range h.actions {
		if a.Game != "" {
			last[a.target()] = a
		}
	}
	recent := append([]Action{}, h.actions[max(0, len(h.actions)-LogLimit):]...) // 비어도 null이 아니라 []
	h.mu.Unlock()
	slices.Reverse(recent)

	byTarget := make(map[string]*Target)
	var targets []*Target
	for _, r := range reports {
		key := r.Game + "/" + r.Comment
		t := byTarget[key]
		if t == nil {
			t = &Target{Game: r.Game, Comment: r.Comment}
			byTarget[key] = t
			targets = append(targets, t)
		}
		t.Reports = append(t.Reports, r)
		if r.At.After(t.Latest) {
			t.Latest = r.At
		}
	}
	for _, t := range targets {
		slices.Reverse(t.Reports)
		if a, ok := last[t.Game+"/"+t.Comment]; ok {
			t.LastAction = &a
			t.Open = t.Latest.After(a.At)
		} else {
			t.Open = true
		}
	}
	slices.SortStableFunc(targets, func(a, b *Target) int {
		if a.Open != b.Open {
			if a.Open {
				return -1
			}
			return 1
		}
		return b.Latest.Compare(a.Latest)
	})
	closed := 0
	targets = slices.DeleteFunc(targets, func(t *Target) bool {
		if t.Open {
			return false
		}
		closed++
		return closed > ClosedLimit
	})

	st := State{Targets: []Target{}, Users: map[string]User{}, Suspended: []string{}, Log: recent, Days: SuspendDays}
	addUser := func(id string) {
		if _, ok := st.Users[id]; !ok && id != "" {
			st.Users[id] = h.user(id)
		}
	}
	for _, t := range targets {
		if t.Comment != "" {
			if c, err := h.Comments.Info(t.Game, t.Comment); err == nil {
				t.CommentInfo = &c
				addUser(c.Author.ID)
			}
		} else if g, ok := h.Uploads.Admin(t.Game); ok {
			t.GameInfo = &g
			addUser(g.Owner)
		}
		for _, r := range t.Reports {
			addUser(r.By)
		}
		st.Targets = append(st.Targets, *t)
	}
	for _, a := range h.Accounts.Suspended() {
		st.Suspended = append(st.Suspended, a.ID)
		addUser(a.ID)
	}
	for _, a := range recent {
		addUser(a.By)
		addUser(a.User)
	}
	return st, nil
}

// ---- 조치 ----

var (
	ErrBadAction = errors.New("bad action")
	ErrNotFound  = errors.New("not found")
	ErrAdmin     = errors.New("cannot suspend an admin") // 운영자는 정지할 수 없음 (자기 자신도)
	ErrTooLong   = errors.New("too long")
)

// Do는 운영자 by의 조치 a를 하고 운영 기록에 남깁니다. 기록을 남기지 못하면 조치는 이미 된 채로 오류를 돌려줍니다.
func (h *Handler) Do(by string, a Action) (Action, error) {
	a.By, a.At, a.Until = by, h.now().UTC(), time.Time{}
	a.Note = strings.TrimSpace(a.Note)
	if utf8.RuneCountInString(a.Note) > MaxNote {
		return Action{}, ErrTooLong
	}
	if (a.Game != "" && !gamePattern.MatchString(a.Game)) || (a.Comment != "" && (a.Game == "" || !commentPattern.MatchString(a.Comment))) {
		return Action{}, ErrBadAction
	}
	if err := h.apply(&a); err != nil {
		return Action{}, err
	}
	data, err := json.Marshal(a)
	if err != nil {
		return Action{}, err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := appendLine(h.file, data); err != nil {
		return a, err
	}
	h.actions = append(h.actions, a)
	return a, nil
}

func (h *Handler) apply(a *Action) error {
	switch a.Action {
	case CommentHide, CommentShow:
		if a.Comment == "" {
			return ErrBadAction
		}
		mod := comment.ModHidden
		if a.Action == CommentShow {
			mod = comment.ModShown
		}
		return notFound(h.Comments.Moderate(a.Game, a.Comment, mod, a.By), comment.ErrNotFound, comment.ErrBadGame)
	case GameBlock, GameUnblock:
		if a.Game == "" || a.Comment != "" {
			return ErrBadAction
		}
		return notFound(h.Uploads.Block(a.Game, a.Action == GameBlock), upload.ErrNotFound)
	case UserSuspend:
		if !slices.Contains(SuspendDays, a.Days) {
			return ErrBadAction
		}
		if h.IDs.Admins[a.User] {
			return ErrAdmin
		}
		if a.Days > 0 {
			a.Until = a.At.Add(time.Duration(a.Days) * 24 * time.Hour)
		}
		return notFound(h.Accounts.Suspend(a.User, a.Until), account.ErrNotFound)
	case UserUnsuspend:
		a.Days = 0
		return notFound(h.Accounts.Unsuspend(a.User), account.ErrNotFound)
	case Dismiss:
		if a.Game == "" {
			return ErrBadAction
		}
		return nil
	}
	return ErrBadAction
}

// notFound는 err가 targets 중 하나면 ErrNotFound로 바꿉니다.
func notFound(err error, targets ...error) error {
	for _, t := range targets {
		if errors.Is(err, t) {
			return ErrNotFound
		}
	}
	return err
}

func appendLine(file string, data []byte) error {
	f, err := os.OpenFile(file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(append(data, '\n'))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// ---- HTTP ----

func (h *Handler) ServeState(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.admin(w, r); !ok {
		return
	}
	st, err := h.State()
	if err != nil {
		log.Printf("운영자 화면을 만들지 못했습니다: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (h *Handler) ServeAction(w http.ResponseWriter, r *http.Request) {
	u, ok := h.admin(w, r)
	if !ok {
		return
	}
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return
	}
	var a Action
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBody)).Decode(&a) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	done, err := h.Do(u.ID, a)
	switch {
	case errors.Is(err, ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
	case errors.Is(err, ErrBadAction), errors.Is(err, ErrAdmin), errors.Is(err, ErrTooLong):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	case err != nil:
		log.Printf("운영 조치 %s 실패: %v", a.Action, err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
	default:
		log.Printf("운영 조치: %s가 %s (게임 %q, 의견 %q, 계정 %q)", done.By, done.Action, done.Game, done.Comment, done.User)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	}
}

// admin은 운영자만 통과시킵니다. 쿠키가 없으면 401, 운영자가 아니면 403 {"error":"admin only"}.
func (h *Handler) admin(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	u, ok := h.IDs.FromRequest(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return identity.User{}, false
	}
	if !u.Admin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "admin only"})
		return identity.User{}, false
	}
	return u, true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
