package ai

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/site"
	"github.com/shin1244/boardmadang/server/internal/upload"
)

var at = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

// metaJSON은 trainer/train.py --export-onnx가 쓰는 틱택토 model.json입니다.
const metaJSON = `{
  "format": 1,
  "game": "tictactoe",
  "version": "0123456789abcdef",
  "lang": "ko",
  "rows": 3,
  "cols": 3,
  "channelNames": ["piece:x", "piece:o", "mark:dot", "mark:ring", "mark:last-move", "mark:danger", "mark:ghost", "mark:blocked", "mark:frame", "tint:0", "tint:1", "tint:other", "text", "toPlay"],
  "specials": [],
  "nActions": 9,
  "channels": 14,
  "sims": 200,
  "iteration": 41,
  "net": {"blocks": 4, "filters": 64},
  "balance": {"games": 2048, "wins": [1100, 900], "draws": 48, "cut": 0, "from": 33, "to": 41}
}`

// onnx는 ONNX 파일처럼 시작하는 바이트입니다 (ir_version 필드)
var onnx = []byte{0x08, 0x0a, 0x12, 0x07, 'p', 'y', 't', 'o', 'r', 'c', 'h'}

type fixture struct {
	dir          string
	store        *Store
	mux          *http.ServeMux
	ids          *identity.Issuer
	games        fakeGames
	accounts     *account.Store
	boss, member identity.User
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{dir: t.TempDir()}
	var err error
	f.store, err = Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	f.store.now = func() time.Time { return at }
	accounts, err := account.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f.accounts = accounts
	f.boss, _, _ = accounts.Create("google", "1", "boss")
	f.member, _, _ = accounts.Create("google", "2", "someone")
	f.ids = identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	f.ids.Members = accounts
	f.ids.Admins = map[string]bool{f.boss.ID: true}
	f.games = fakeGames{}
	h := Handler{Store: f.store, IDs: f.ids, Games: f.games, Known: func(id string) bool {
		_, ok := f.games[id]
		return ok || id == "tictactoe"
	}}
	f.mux = http.NewServeMux()
	f.mux.HandleFunc("GET /ai/{game}/{file}", h.ServeFile)
	f.mux.HandleFunc("GET /api/ai/mine", h.ServeMine)
	f.mux.HandleFunc("POST /api/ai/{game}/request", h.ServeAsk)
	f.mux.HandleFunc("DELETE /api/ai/{game}/request", h.ServeCancel)
	f.mux.HandleFunc("GET /api/ai/{game}/training", h.ServeTraining)
	f.mux.HandleFunc("GET /api/admin/ai/requests", h.ServeRequests)
	f.mux.HandleFunc("POST /api/admin/ai/{game}/code", h.ServeCode)
	f.mux.HandleFunc("POST /api/admin/ai/{game}/decline", h.ServeDecline)
	f.mux.HandleFunc("PUT /api/admin/ai/{game}", h.ServePut)
	f.mux.HandleFunc("DELETE /api/admin/ai/{game}", h.ServeDelete)
	f.mux.HandleFunc("PUT /api/admin/ai/{game}/training", h.ServePutTraining)
	return f
}

// fakeGames는 올린 게임 쪽(upload.Store)을 흉내 냅니다. 게임 id → 주인과 지금 버전
type fakeGames map[string]upload.AdminGame

func (g fakeGames) add(id, owner, version string) {
	g[id] = upload.AdminGame{MyGame: upload.MyGame{Game: site.Game{ID: id, Version: version}}, Owner: owner}
}

func (g fakeGames) Admin(id string) (upload.AdminGame, bool) {
	x, ok := g[id]
	return x, ok
}

func (g fakeGames) Mine(owner string) upload.Mine {
	out := upload.Mine{Games: []upload.MyGame{}}
	for _, x := range g {
		if x.Owner == owner {
			out.Games = append(out.Games, x.MyGame)
		}
	}
	return out
}

func (g fakeGames) CodeZip(id, version string) ([]byte, error) {
	if _, ok := g[id]; !ok || version == "ffffffffffffffff" {
		return nil, upload.ErrNotFound
	}
	return []byte("zip of " + id + " " + version), nil
}

func (f *fixture) do(method, path, ctype, body string, u *identity.User) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	if u != nil {
		req.AddCookie(&http.Cookie{Name: identity.CookieName, Value: f.ids.Sign(*u)})
	}
	rec := httptest.NewRecorder()
	f.mux.ServeHTTP(rec, req)
	return rec
}

// put은 운영자로 모델을 올립니다. edit으로 model.json을 고쳐 볼 수 있습니다
func (f *fixture) put(game string, model []byte, edit func(m map[string]any)) *httptest.ResponseRecorder {
	var meta map[string]any
	json.Unmarshal([]byte(metaJSON), &meta)
	if edit != nil {
		edit(meta)
	}
	body, _ := json.Marshal(map[string]any{"meta": meta, "model": base64.StdEncoding.EncodeToString(model)})
	return f.do("PUT", "/api/admin/ai/"+game, "application/json", string(body), &f.boss)
}

func TestPutServeAndReopen(t *testing.T) {
	f := setup(t)
	rec := f.put("tictactoe", onnx, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	got := f.store.Model("tictactoe")
	if got == nil || !strings.HasPrefix(got.Model, "/ai/tictactoe/") || !strings.HasSuffix(got.Model, ".onnx") {
		t.Fatalf("model = %+v", got)
	}
	if *got.Version != "0123456789abcdef" || got.Lang != "ko" || got.NActions != 9 || got.Sims != 200 || len(got.ChannelNames) != 14 || !got.Updated.Equal(at) {
		t.Errorf("model = %+v", got)
	}
	if b := got.Balance; b == nil || b.Games != 2048 || b.Wins != [2]int{1100, 900} || b.Draws != 48 || b.From != 33 || b.To != 41 {
		t.Errorf("balance = %+v", got.Balance)
	}
	if f.store.Model("dots") != nil {
		t.Error("dots has no model")
	}

	// 누구나 받을 수 있고, 이름이 내용의 해시라 오래 캐시합니다
	rec = f.do("GET", got.Model, "", "", nil)
	if rec.Code != http.StatusOK || rec.Body.String() != string(onnx) {
		t.Fatalf("GET %s = %d %q", got.Model, rec.Code, rec.Body)
	}
	if c := rec.Header().Get("Cache-Control"); !strings.Contains(c, "immutable") {
		t.Errorf("Cache-Control = %q", c)
	}
	for _, p := range []string{"/ai/tictactoe/model.json", "/ai/tictactoe/0000000000000000.onnx", "/ai/dots/" + filepath.Base(got.Model), "/ai/tictactoe/..%2fmodel.json"} {
		if rec := f.do("GET", p, "", "", nil); rec.Code != http.StatusNotFound {
			t.Errorf("GET %s = %d, want 404", p, rec.Code)
		}
	}

	// 다시 열어도 같습니다
	again, err := Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if m := again.Model("tictactoe"); m == nil || m.Model != got.Model {
		t.Errorf("reopened model = %+v", m)
	}
	var saved Meta
	data, _ := os.ReadFile(filepath.Join(f.dir, "ai", "tictactoe", "model.json"))
	if json.Unmarshal(data, &saved) != nil || saved.By != f.boss.ID || saved.Size != len(onnx) || saved.Iteration != 41 || saved.Net.Filters != 64 {
		t.Errorf("model.json = %s", data)
	}
}

// 새로 올리면 옛 신경망 파일은 지웁니다. 지우면 /api/games에서 빠집니다
func TestReplaceAndDelete(t *testing.T) {
	f := setup(t)
	f.put("tictactoe", onnx, nil)
	first := f.store.Model("tictactoe").Model
	second := append([]byte{}, onnx...)
	second = append(second, 0x00)
	if rec := f.put("tictactoe", second, func(m map[string]any) { m["version"] = nil; m["sims"] = 50 }); rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	m := f.store.Model("tictactoe")
	if m.Model == first || m.Version != nil || m.Sims != 50 {
		t.Errorf("replaced model = %+v", m)
	}
	if rec := f.do("GET", first, "", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("old file = %d, want 404", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(f.dir, "ai", "tictactoe", filepath.Base(first))); !os.IsNotExist(err) {
		t.Errorf("old file is still there: %v", err)
	}

	if rec := f.do("DELETE", "/api/admin/ai/tictactoe", "", "", &f.member); rec.Code != http.StatusForbidden {
		t.Errorf("delete by a member = %d, want 403", rec.Code)
	}
	if rec := f.do("DELETE", "/api/admin/ai/tictactoe", "", "", &f.boss); rec.Code != http.StatusOK {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body)
	}
	if f.store.Model("tictactoe") != nil {
		t.Error("deleted model is still listed")
	}
	if rec := f.do("GET", m.Model, "", "", nil); rec.Code != http.StatusNotFound {
		t.Errorf("deleted file = %d, want 404", rec.Code)
	}
	if rec := f.do("DELETE", "/api/admin/ai/tictactoe", "", "", &f.boss); rec.Code != http.StatusNotFound {
		t.Errorf("delete again = %d, want 404", rec.Code)
	}
}

func TestPutChecks(t *testing.T) {
	f := setup(t)
	if rec := f.do("PUT", "/api/admin/ai/tictactoe", "application/json", "{}", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("no cookie = %d, want 401", rec.Code)
	}
	if rec := f.do("PUT", "/api/admin/ai/tictactoe", "application/json", "{}", &f.member); rec.Code != http.StatusForbidden {
		t.Errorf("member = %d, want 403", rec.Code)
	}
	// 다른 사이트의 폼은 JSON을 보낼 수 없습니다
	if rec := f.do("PUT", "/api/admin/ai/tictactoe", "multipart/form-data", "{}", &f.boss); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form = %d, want 415", rec.Code)
	}
	if rec := f.do("PUT", "/api/admin/ai/tictactoe", "application/json", `{"meta":{},"model":"!!"}`, &f.boss); rec.Code != http.StatusBadRequest {
		t.Errorf("bad base64 = %d, want 400", rec.Code)
	}
	if rec := f.put("nope", onnx, func(m map[string]any) { m["game"] = "nope" }); rec.Code != http.StatusNotFound {
		t.Errorf("unknown game = %d, want 404", rec.Code)
	}
	balance := func(b string) func(m map[string]any) {
		return func(m map[string]any) { m["balance"] = json.RawMessage(b) }
	}
	bad := map[string]func(m map[string]any){
		"other game":     func(m map[string]any) { m["game"] = "dots" },
		"format":         func(m map[string]any) { m["format"] = 2 },
		"version":        func(m map[string]any) { m["version"] = "v1" },
		"lang":           func(m map[string]any) { m["lang"] = "" },
		"rows":           func(m map[string]any) { m["rows"] = 0 },
		"nActions":       func(m map[string]any) { m["nActions"] = 10 },
		"channels":       func(m map[string]any) { m["channels"] = 13 },
		"no channels":    func(m map[string]any) { m["channelNames"] = []string{}; m["channels"] = 0 },
		"empty name":     func(m map[string]any) { m["channelNames"] = []string{""}; m["channels"] = 1 },
		"control char":   func(m map[string]any) { m["specials"] = []string{"pa\nss"}; m["nActions"] = 10 },
		"sims":           func(m map[string]any) { m["sims"] = 0 },
		"too many sims":  func(m map[string]any) { m["sims"] = MaxSims + 1 },
		"many specials":  func(m map[string]any) { m["specials"] = strings.Split("abcdefghi", ""); m["nActions"] = 18 },
		"negative count": func(m map[string]any) { m["iteration"] = -1 },
		"no games":       balance(`{"games": 0, "wins": [0, 0]}`),
		"too many wins":  balance(`{"games": 10, "wins": [6, 5]}`),
		"cut over draws": balance(`{"games": 10, "wins": [5, 4], "draws": 1, "cut": 2}`),
		"from after to":  balance(`{"games": 10, "wins": [5, 5], "from": 9, "to": 8}`),
	}
	for name, edit := range bad {
		if rec := f.put("tictactoe", onnx, edit); rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s, want 422", name, rec.Code, rec.Body)
		}
	}
	// 이 기능 전에 내보낸 model.json에는 balance가 없습니다
	if rec := f.put("tictactoe", onnx, func(m map[string]any) { delete(m, "balance") }); rec.Code != http.StatusOK || f.store.Model("tictactoe").Balance != nil {
		t.Errorf("without balance: %d %s", rec.Code, rec.Body)
	}
	// 특수 행동은 클릭 뒤에 붙습니다
	if rec := f.put("tictactoe", onnx, func(m map[string]any) { m["specials"] = []string{"pass"}; m["nActions"] = 10 }); rec.Code != http.StatusOK {
		t.Errorf("with a special action: %d %s", rec.Code, rec.Body)
	}
	for name, model := range map[string][]byte{"empty": {}, "not onnx": []byte("PK\x03\x04"), "too big": append([]byte{0x08}, make([]byte, MaxModel)...)} {
		if rec := f.put("tictactoe", model, nil); rec.Code != http.StatusUnprocessableEntity && rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s model: %d, want 422 or 413", name, rec.Code)
		}
	}
	if f.store.Model("tictactoe").NActions != 10 {
		t.Error("a bad upload replaced the model")
	}
}

// 손으로 망가뜨린 model.json은 열 때 건너뜁니다
func TestOpenSkipsBroken(t *testing.T) {
	dir := t.TempDir()
	for game, body := range map[string]string{"a": "{", "b": `{"format":1,"game":"other"}`} {
		os.MkdirAll(filepath.Join(dir, "ai", game), 0o755)
		os.WriteFile(filepath.Join(dir, "ai", game, "model.json"), []byte(body), 0o644)
	}
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if s.Model("a") != nil || s.Model("b") != nil {
		t.Error("broken models are listed")
	}
}
