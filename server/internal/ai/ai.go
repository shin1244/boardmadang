// Package ai는 브라우저에서 AI와 둘 때 쓰는 학습한 신경망을 보관하고 내보냅니다 (trainer/README.md의 "브라우저에서 AI와 두기").
//
// 운영자가 자기 컴퓨터에서 학습하고(python trainer/train.py <게임> --minutes 60) 내보낸 뒤(--export-onnx),
// 운영자 화면에서 model.onnx와 model.json을 올립니다. 레포 게임과 올린 게임이 같은 곳을 씁니다.
//
//	GET    /ai/{game}/{file}      신경망 (<해시>.onnx, 누구나). 내용의 해시가 이름이라 오래 캐시합니다
//	PUT    /api/admin/ai/{game}   운영자만. JSON {"meta": model.json, "model": model.onnx의 base64} → 200 {"ai": site.AIModel}
//	DELETE /api/admin/ai/{game}   운영자만 → 200 {"ok":true}
//
// /api/games의 게임마다 ai(site.AIModel)로 붙여서, 화면은 그 모양(관측 채널 이름, 판 크기, 특수 행동)이 지금 게임 코드와
// 같을 때만 "AI와 두기"를 보여 줍니다. 코드 버전이 달라도 모양이 같으면 씁니다 (규칙을 조금 고친 정도면 대개 쓸 만함).
// 운영자가 아니면 쿠키가 없을 때 401, 있으면 403 {"error":"admin only"}. 본문은 JSON만 받습니다 (다른 사이트의 폼은 못 보냄).
//
// DATA_DIR 아래에 이렇게 씁니다.
//
//	ai/<게임 id>/model.json     올린 model.json을 검사해 정리한 것 + 신경망 파일 이름, 크기, 올린 때, 올린 운영자
//	ai/<게임 id>/<해시>.onnx    신경망. 새로 올리면 model.json을 바꾼 뒤 옛 파일을 지웁니다
package ai

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/shin1244/boardmadang/server/internal/site"
)

const (
	Format   = 1        // model.json의 format (trainer/train.py의 MODEL_FORMAT)
	MaxModel = 16 << 20 // 신경망 파일의 크기. 스플체스의 6블록 96필터가 4MB쯤이고, 이보다 크면 브라우저에서 너무 느립니다
	MaxSims  = 2000     // 브라우저 AI의 한 수 탐색 횟수
)

var (
	ErrNotFound = errors.New("no such game")
	ErrNoModel  = errors.New("no model")
)

// BadMeta는 올린 model.json이나 신경망이 규칙에 맞지 않을 때입니다.
type BadMeta struct{ Reason string }

func (e BadMeta) Error() string { return "bad model: " + e.Reason }

var (
	gamePattern    = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	versionPattern = regexp.MustCompile(`^[0-9a-f]{16}$`)
	langPattern    = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$`)
	filePattern    = regexp.MustCompile(`^[0-9a-f]{16}\.onnx$`)
)

// Meta는 model.json입니다. 앞쪽은 trainer/train.py의 export_onnx가 쓰는 칸이고, 뒤쪽은 서버가 채웁니다.
type Meta struct {
	Format       int       `json:"format"`
	Game         string    `json:"game"`
	Version      *string   `json:"version"` // 학습한 게임 코드 버전. 이 기능 전에 학습한 모델이면 null
	Lang         string    `json:"lang"`    // 학습할 때 view()와 result()에 넘긴 언어
	Rows         int       `json:"rows"`
	Cols         int       `json:"cols"`
	ChannelNames []string  `json:"channelNames"`
	Specials     []string  `json:"specials"`
	NActions     int       `json:"nActions"`
	Channels     int       `json:"channels"`
	Sims         int       `json:"sims"`
	Iteration    int       `json:"iteration,omitempty"`
	Net          *NetSize  `json:"net,omitempty"`
	File         string    `json:"file"`    // 서버가 채움: <해시>.onnx
	Size         int       `json:"size"`    // 서버가 채움: 신경망 파일 크기
	Updated      time.Time `json:"updated"` // 서버가 채움
	By           string    `json:"by"`      // 서버가 채움: 올린 운영자 계정 id
}

// NetSize는 신경망 크기입니다 (보여 주기만 합니다).
type NetSize struct {
	Blocks  int `json:"blocks"`
	Filters int `json:"filters"`
}

// Store는 DATA_DIR/ai입니다. Open으로 엽니다.
type Store struct {
	dir string
	now func() time.Time

	mu     sync.Mutex
	models map[string]Meta // 게임 id → model.json
}

// Open은 dir/ai를 읽습니다. 깨진 model.json은 건너뜁니다 (로그만 남김).
func Open(dir string) (*Store, error) {
	s := &Store{dir: filepath.Join(dir, "ai"), now: time.Now, models: map[string]Meta{}}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() || !gamePattern.MatchString(e.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.dir, e.Name(), "model.json"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		var m Meta
		if err == nil {
			err = json.Unmarshal(data, &m)
		}
		if err == nil {
			err = m.check(e.Name())
		}
		if err == nil && !filePattern.MatchString(m.File) {
			err = errors.New("bad file name")
		}
		if err != nil {
			log.Printf("AI 모델을 건너뜁니다 (%s): %v", e.Name(), err)
			continue
		}
		s.models[e.Name()] = m
	}
	return s, nil
}

// check는 올린 model.json의 칸을 검사합니다. game은 올리는 주소의 게임 id입니다.
func (m *Meta) check(game string) error {
	bad := func(format string, args ...any) error { return BadMeta{fmt.Sprintf(format, args...)} }
	switch {
	case m.Format != Format:
		return bad("format must be %d", Format)
	case m.Game != game:
		return bad("this model is for %q", m.Game)
	case m.Version != nil && !versionPattern.MatchString(*m.Version):
		return bad("version must be 16 hex digits or null")
	case !langPattern.MatchString(m.Lang):
		return bad("lang")
	case m.Rows < 1 || m.Rows > 32 || m.Cols < 1 || m.Cols > 32:
		return bad("rows and cols must be 1-32")
	case len(m.ChannelNames) < 1 || len(m.ChannelNames) > 256 || m.Channels != len(m.ChannelNames):
		return bad("channels must match channelNames (1-256)")
	case len(m.Specials) > 8:
		return bad("too many specials")
	case m.NActions != m.Rows*m.Cols+len(m.Specials):
		return bad("nActions must be rows × cols + specials")
	case m.Sims < 1 || m.Sims > MaxSims:
		return bad("sims must be 1-%d", MaxSims)
	case m.Iteration < 0:
		return bad("iteration")
	}
	for _, list := range [][]string{m.ChannelNames, m.Specials} {
		for _, s := range list {
			if s == "" || utf8.RuneCountInString(s) > 64 || strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 }) {
				return bad("names must be 1-64 printable characters")
			}
		}
	}
	if m.Specials == nil {
		m.Specials = []string{}
	}
	return nil
}

// Model은 /api/games에 붙일 게임 하나의 모델입니다. 없으면 nil.
func (s *Store) Model(game string) *site.AIModel {
	s.mu.Lock()
	m, ok := s.models[game]
	s.mu.Unlock()
	if !ok {
		return nil
	}
	return m.summary()
}

func (m Meta) summary() *site.AIModel {
	return &site.AIModel{
		Model:        "/ai/" + m.Game + "/" + m.File,
		Version:      m.Version,
		Lang:         m.Lang,
		Rows:         m.Rows,
		Cols:         m.Cols,
		ChannelNames: m.ChannelNames,
		Specials:     m.Specials,
		NActions:     m.NActions,
		Sims:         m.Sims,
		Updated:      m.Updated,
	}
}

// Put은 운영자 by가 올린 모델을 저장합니다. 같은 게임의 모델이 있으면 바꿉니다.
func (s *Store) Put(by, game string, meta Meta, model []byte) (Meta, error) {
	if err := meta.check(game); err != nil {
		return Meta{}, err
	}
	// ONNX 파일은 protobuf ModelProto이고 첫 칸이 ir_version(1번 varint)입니다. 다른 파일을 잘못 고른 것을 거릅니다
	if len(model) == 0 || len(model) > MaxModel || model[0] != 0x08 {
		return Meta{}, BadMeta{"model must be an ONNX file up to 16MB"}
	}
	sum := sha256.Sum256(model)
	meta.File = hex.EncodeToString(sum[:])[:16] + ".onnx"
	meta.Size = len(model)
	meta.Updated = s.now().UTC()
	meta.By = by
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return Meta{}, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, game)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return Meta{}, err
	}
	// 신경망 파일을 먼저 쓰고 model.json을 바꿉니다. 그사이에 화면이 받아 가는 것은 늘 짝이 맞습니다
	if err := writeFile(filepath.Join(dir, meta.File), model); err != nil {
		return Meta{}, err
	}
	if err := writeFile(filepath.Join(dir, "model.json"), append(data, '\n')); err != nil {
		return Meta{}, err
	}
	if old, ok := s.models[game]; ok && old.File != meta.File {
		os.Remove(filepath.Join(dir, old.File))
	}
	s.models[game] = meta
	return meta, nil
}

// Delete는 게임의 모델을 지웁니다.
func (s *Store) Delete(game string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.models[game]; !ok {
		return ErrNoModel
	}
	if err := os.RemoveAll(filepath.Join(s.dir, game)); err != nil {
		return err
	}
	delete(s.models, game)
	return nil
}

// file은 내보낼 신경망 파일입니다. 지금 모델의 파일만 내보냅니다.
func (s *Store) file(game, name string) ([]byte, error) {
	s.mu.Lock()
	m, ok := s.models[game]
	s.mu.Unlock()
	if !ok || m.File != name {
		return nil, ErrNoModel
	}
	return os.ReadFile(filepath.Join(s.dir, game, name))
}

// writeFile은 임시 파일에 쓰고 이름을 바꿉니다. 쓰다가 꺼져도 반쯤 쓴 파일이 남지 않습니다.
func writeFile(name string, data []byte) error {
	tmp := name + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, name)
}
