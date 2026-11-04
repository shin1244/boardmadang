package ai

import (
	"cmp"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

// AI 만들기 요청 (제작자 → 운영자).
//
// 제작자가 내 프로필의 "내가 올린 게임"에서 "AI 만들기"를 누르면 그때의 코드 버전으로 요청이 생깁니다 (waiting).
// 운영자가 운영자 화면에서 코드를 받으면 학습 중(training)이 되고, 자기 컴퓨터에서 학습한 뒤 모델을 올리면 끝(done)입니다.
// 학습할 수 없는 게임이면 이유를 적어 반려합니다(declined). 제작자는 기다리는 동안 취소할 수 있습니다 (요청이 지워짐).
//
//	ai/<게임 id>/request.json   게임마다 마지막 요청 하나

const (
	StatusWaiting  = "waiting"
	StatusTraining = "training"
	StatusDone     = "done"
	StatusDeclined = "declined"

	MaxNote       = 500 // 반려 이유 글자 수
	ClosedListed  = 30  // 운영자 화면에 보여 줄 끝난 요청 수
	OpenPerMember = 1   // 계정마다 동시에 둘 수 있는 요청 (docs/abuse-and-limits.md)
)

var (
	ErrOpen     = errors.New("request open")     // 이 게임에 이미 요청이 있음
	ErrBusy     = errors.New("another request")  // 이 계정의 다른 게임 요청이 아직 안 끝남
	ErrTrained  = errors.New("already trained")  // 이 버전으로 학습한 모델이 이미 있음
	ErrNoAsk    = errors.New("no request")       // 요청이 없거나 이미 끝남
	ErrNotYours = errors.New("not your request") // 다른 사람의 요청
)

// Request는 AI 만들기 요청 하나입니다.
type Request struct {
	Game    string    `json:"game"`
	Version string    `json:"version"` // 요청한 때의 게임 코드 버전. 운영자는 이 버전의 코드를 받습니다
	By      string    `json:"by"`      // 요청한 제작자 계정 id
	At      time.Time `json:"at"`
	Status  string    `json:"status"`         // waiting | training | done | declined
	Note    string    `json:"note,omitempty"` // 반려 이유
	Updated time.Time `json:"updated"`
}

func (r Request) open() bool { return r.Status == StatusWaiting || r.Status == StatusTraining }

// Ask는 제작자 by가 게임의 지금 버전으로 AI를 요청합니다. 게임 주인인지는 부르는 쪽(http.go)이 봅니다.
func (s *Store) Ask(by, game, version string) (Request, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.requests[game]; ok && r.open() {
		return Request{}, ErrOpen
	}
	if m, ok := s.models[game]; ok && m.Version != nil && *m.Version == version {
		return Request{}, ErrTrained
	}
	open := 0
	for _, r := range s.requests {
		if r.By == by && r.open() {
			open++
		}
	}
	if open >= OpenPerMember {
		return Request{}, ErrBusy
	}
	now := s.now().UTC()
	r := Request{Game: game, Version: version, By: by, At: now, Status: StatusWaiting, Updated: now}
	return r, s.saveRequest(r)
}

// Cancel은 제작자 by가 기다리는 중인 요청을 거둡니다. 운영자가 이미 받아 간 요청은 거둘 수 없습니다.
func (s *Store) Cancel(by, game string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[game]
	if !ok || r.Status != StatusWaiting {
		return ErrNoAsk
	}
	if r.By != by {
		return ErrNotYours
	}
	if err := os.Remove(filepath.Join(s.dir, game, "request.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	delete(s.requests, game)
	return nil
}

// RequestOf는 게임의 마지막 요청입니다.
func (s *Store) RequestOf(game string) (Request, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[game]
	return r, ok
}

// Requests는 운영자 화면의 요청 목록입니다. 아직 안 끝난 요청을 먼저(오래된 것부터), 그다음 끝난 요청을 최근 것부터 ClosedListed개.
func (s *Store) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	var open, closed []Request
	for _, r := range s.requests {
		if r.open() {
			open = append(open, r)
		} else {
			closed = append(closed, r)
		}
	}
	slices.SortFunc(open, func(a, b Request) int { return cmp.Or(a.At.Compare(b.At), strings.Compare(a.Game, b.Game)) })
	slices.SortFunc(closed, func(a, b Request) int { return cmp.Or(b.Updated.Compare(a.Updated), strings.Compare(a.Game, b.Game)) })
	return append(append([]Request{}, open...), closed[:min(len(closed), ClosedListed)]...)
}

// Take는 운영자가 코드를 받아 갈 때 요청을 학습 중으로 바꿉니다. 요청이 없거나 끝났으면 그대로 두고 false입니다.
func (s *Store) Take(game string) (Request, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[game]
	if !ok || !r.open() {
		return r, false, nil
	}
	if r.Status == StatusTraining {
		return r, true, nil
	}
	r.Status = StatusTraining
	r.Updated = s.now().UTC()
	return r, true, s.saveRequest(r)
}

// Decline은 운영자가 요청을 반려합니다. note는 제작자에게 보이는 이유입니다.
func (s *Store) Decline(game, note string) (Request, error) {
	note = strings.TrimSpace(note)
	if utf8.RuneCountInString(note) > MaxNote {
		return Request{}, BadMeta{"note is too long"}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.requests[game]
	if !ok || !r.open() {
		return Request{}, ErrNoAsk
	}
	r.Status = StatusDeclined
	r.Note = note
	r.Updated = s.now().UTC()
	return r, s.saveRequest(r)
}

// finish는 모델을 올렸을 때 그 게임의 열린 요청을 끝냅니다. s.mu를 잡고 부릅니다.
func (s *Store) finish(game string) error {
	r, ok := s.requests[game]
	if !ok || !r.open() {
		return nil
	}
	r.Status = StatusDone
	r.Updated = s.now().UTC()
	return s.saveRequest(r)
}

// saveRequest는 request.json을 쓰고 메모리에도 둡니다. s.mu를 잡고 부릅니다.
func (s *Store) saveRequest(r Request) error {
	dir := filepath.Join(s.dir, r.Game)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFile(filepath.Join(dir, "request.json"), append(data, '\n')); err != nil {
		return err
	}
	s.requests[r.Game] = r
	return nil
}

func (r Request) valid(game string) bool {
	switch r.Status {
	case StatusWaiting, StatusTraining, StatusDone, StatusDeclined:
	default:
		return false
	}
	return r.Game == game && versionPattern.MatchString(r.Version) && r.By != ""
}
