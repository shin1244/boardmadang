package ai

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

const dotsVersion = "0123456789abcdef"

// snapshotsJSON은 trainer/train.py가 쓰는 snapshots.json 모양입니다 (학습 전 하나, 10분 뒤 하나).
const snapshotsJSON = `{
  "format": 1, "game": "dots", "version": "0123456789abcdef", "lang": "ko", "minutes": 60,
  "snapshots": [
    {"minute": 0, "iteration": 0, "selfplay": null, "games": [
      {"seed": 1, "moves": [{"player": 0, "action": {"kind": "click", "row": 1, "col": 1}}, {"player": 1, "action": {"kind": "pass"}}], "winner": null, "reason": "cut"}
    ]},
    {"minute": 10.2, "iteration": 37, "selfplay": {"games": 3700, "wins": [700, 200], "draws": 2800, "cut": 12, "moves": 31000},
     "eval": {"random": {"first": [24, 0, 0], "second": [14, 2, 0]}, "accuracy": {"policy": 0.95, "search": 0.99}},
     "games": [{"seed": 1, "moves": [{"player": 0, "action": {"kind": "click", "row": 0, "col": 2}}], "winner": 0, "reason": "result"}]}
  ]
}`

func decode[T any](t *testing.T, body string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	return v
}

// 제작자의 요청 → 운영자가 코드를 받음(학습 중) → 학습 기록과 모델을 올림(끝)
func TestRequestFlow(t *testing.T) {
	f := setup(t)
	creator, admin := &f.member, &f.boss
	f.games.add("dots", creator.ID, dotsVersion)
	f.games.add("dots2", creator.ID, "1111111111111111")
	f.games.add("other", admin.ID, "2222222222222222")

	ask := func(game string, u *identity.User) int {
		return f.do("POST", "/api/ai/"+game+"/request", "application/json", "{}", u).Code
	}
	if c := ask("dots", nil); c != http.StatusUnauthorized {
		t.Errorf("no session = %d", c)
	}
	if rec := f.do("POST", "/api/ai/dots/request", "text/plain", "{}", creator); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("form body = %d", rec.Code)
	}
	for _, game := range []string{"other", "tictactoe", "nope", "Bad!"} {
		if c := ask(game, creator); c != http.StatusNotFound {
			t.Errorf("ask %s = %d, want 404", game, c)
		}
	}
	rec := f.do("POST", "/api/ai/dots/request", "application/json", "{}", creator)
	if rec.Code != http.StatusOK {
		t.Fatalf("ask = %d %s", rec.Code, rec.Body)
	}
	req := decode[struct{ Request Request }](t, rec.Body.String()).Request
	if req.Status != StatusWaiting || req.Version != dotsVersion || req.By != creator.ID || !req.At.Equal(at) {
		t.Fatalf("request = %+v", req)
	}
	if c := ask("dots", creator); c != http.StatusConflict {
		t.Errorf("ask again = %d, want 409", c)
	}
	// 한 계정은 요청 하나만 기다립니다
	if c := ask("dots2", creator); c != http.StatusTooManyRequests {
		t.Errorf("second game = %d, want 429", c)
	}

	// 기다리는 동안은 거둘 수 있습니다. 남이 거둘 수는 없습니다
	if rec := f.do("DELETE", "/api/ai/dots/request", "", "", admin); rec.Code != http.StatusNotFound {
		t.Errorf("cancel by someone else = %d", rec.Code)
	}
	if rec := f.do("DELETE", "/api/ai/dots/request", "", "", creator); rec.Code != http.StatusOK {
		t.Fatalf("cancel = %d %s", rec.Code, rec.Body)
	}
	if rec := f.do("DELETE", "/api/ai/dots/request", "", "", creator); rec.Code != http.StatusConflict {
		t.Errorf("cancel again = %d", rec.Code)
	}
	if c := ask("dots", creator); c != http.StatusOK {
		t.Fatalf("ask after cancel = %d", c)
	}

	// 운영자 화면
	if rec := f.do("GET", "/api/admin/ai/requests", "", "", creator); rec.Code != http.StatusForbidden {
		t.Errorf("requests by a member = %d", rec.Code)
	}
	rec = f.do("GET", "/api/admin/ai/requests", "", "", admin)
	list := decode[struct{ Requests []Request }](t, rec.Body.String()).Requests
	if len(list) != 1 || list[0].Game != "dots" || list[0].Status != StatusWaiting {
		t.Fatalf("requests = %s", rec.Body)
	}

	// 코드를 받으면 학습 중이 됩니다. 제작자가 그사이 새 버전을 올려도 요청한 버전의 코드를 줍니다
	f.games.add("dots", creator.ID, "3333333333333333")
	if rec := f.do("POST", "/api/admin/ai/dots/code", "application/json", "{}", creator); rec.Code != http.StatusForbidden {
		t.Errorf("code by a member = %d", rec.Code)
	}
	if rec := f.do("POST", "/api/admin/ai/dots/code", "", "", admin); rec.Code != http.StatusUnsupportedMediaType {
		t.Errorf("code without JSON = %d", rec.Code)
	}
	if rec := f.do("POST", "/api/admin/ai/tictactoe/code", "application/json", "{}", admin); rec.Code != http.StatusNotFound {
		t.Errorf("code of a repo game = %d", rec.Code)
	}
	rec = f.do("POST", "/api/admin/ai/dots/code", "application/json", "{}", admin)
	if rec.Code != http.StatusOK || rec.Body.String() != "zip of dots "+dotsVersion || rec.Header().Get("Content-Type") != "application/zip" ||
		!strings.Contains(rec.Header().Get("Content-Disposition"), "dots-"+dotsVersion+".zip") {
		t.Fatalf("code = %d %q %v", rec.Code, rec.Body, rec.Header())
	}
	if r, _ := f.store.RequestOf("dots"); r.Status != StatusTraining {
		t.Errorf("after code = %+v", r)
	}
	if rec := f.do("DELETE", "/api/ai/dots/request", "", "", creator); rec.Code != http.StatusConflict {
		t.Errorf("cancel while training = %d", rec.Code)
	}

	// 학습 기록: 게임 주인과 운영자만 봅니다
	if rec := f.do("GET", "/api/ai/dots/training", "", "", creator); rec.Code != http.StatusNotFound {
		t.Errorf("training before upload = %d", rec.Code)
	}
	if rec := f.do("PUT", "/api/admin/ai/dots/training", "application/json", snapshotsJSON, creator); rec.Code != http.StatusForbidden {
		t.Errorf("training put by a member = %d", rec.Code)
	}
	rec = f.do("PUT", "/api/admin/ai/dots/training", "application/json", snapshotsJSON, admin)
	if rec.Code != http.StatusOK {
		t.Fatalf("training put = %d %s", rec.Code, rec.Body)
	}
	if info := decode[struct{ Training TrainingInfo }](t, rec.Body.String()).Training; info.Snapshots != 2 || info.Minutes != 60 || *info.Version != dotsVersion {
		t.Errorf("training info = %+v", info)
	}
	for _, c := range []struct {
		u    *identity.User
		want int
	}{{creator, http.StatusOK}, {admin, http.StatusOK}, {nil, http.StatusUnauthorized}} {
		if rec := f.do("GET", "/api/ai/dots/training", "", "", c.u); rec.Code != c.want {
			t.Errorf("training get = %d, want %d", rec.Code, c.want)
		}
	}
	other, _, _ := f.accounts.Create("google", "3", "stranger")
	if rec := f.do("GET", "/api/ai/dots/training", "", "", &other); rec.Code != http.StatusNotFound {
		t.Errorf("training by a stranger = %d, want 404", rec.Code)
	}
	rec = f.do("GET", "/api/ai/dots/training", "", "", creator)
	got := decode[Training](t, rec.Body.String())
	if len(got.Snapshots) != 2 || got.By != admin.ID || got.Snapshots[1].Selfplay.Cut != 12 || got.Snapshots[1].Eval.Accuracy.Search != 0.99 ||
		got.Snapshots[0].Games[0].Moves[1].Action.Kind != "pass" || got.Snapshots[0].Games[0].Winner != nil {
		t.Errorf("training = %s", rec.Body)
	}

	// 모델을 올리면 요청이 끝납니다. 같은 버전으로는 다시 요청할 수 없습니다
	if rec := f.put("dots", onnx, func(m map[string]any) { m["game"] = "dots" }); rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body)
	}
	if r, _ := f.store.RequestOf("dots"); r.Status != StatusDone {
		t.Errorf("after model = %+v", r)
	}
	rec = f.do("GET", "/api/ai/mine", "", "", creator)
	mine := decode[struct{ Games map[string]MyAI }](t, rec.Body.String()).Games
	if d := mine["dots"]; d.Request == nil || d.Request.Status != StatusDone || d.AI == nil || d.Training == nil || d.Training.Snapshots != 2 {
		t.Errorf("mine dots = %s", rec.Body)
	}
	if d, ok := mine["dots2"]; !ok || d.Request != nil || d.AI != nil {
		t.Errorf("mine dots2 = %s", rec.Body)
	}
	if _, ok := mine["other"]; ok {
		t.Errorf("mine has someone else's game: %s", rec.Body)
	}
	f.games.add("dots", creator.ID, dotsVersion)
	if c := ask("dots", creator); c != http.StatusConflict {
		t.Errorf("ask for the trained version = %d, want 409", c)
	}

	// 반려하면 이유가 남고 다시 요청할 수 있습니다
	f.store.now = func() time.Time { return at.Add(time.Hour) }
	if c := ask("dots2", creator); c != http.StatusOK {
		t.Fatalf("ask dots2 = %d", c)
	}
	if rec := f.do("POST", "/api/admin/ai/dots2/decline", "application/json", `{"note":"`+strings.Repeat("가", MaxNote+1)+`"}`, admin); rec.Code != http.StatusUnprocessableEntity {
		t.Errorf("long note = %d", rec.Code)
	}
	rec = f.do("POST", "/api/admin/ai/dots2/decline", "application/json", `{"note":" turn()이 늘 0이라 학습할 수 없습니다 "}`, admin)
	if r := decode[struct{ Request Request }](t, rec.Body.String()).Request; rec.Code != http.StatusOK || r.Status != StatusDeclined || r.Note != "turn()이 늘 0이라 학습할 수 없습니다" {
		t.Fatalf("decline = %d %s", rec.Code, rec.Body)
	}
	if rec := f.do("POST", "/api/admin/ai/dots2/decline", "application/json", `{}`, admin); rec.Code != http.StatusConflict {
		t.Errorf("decline again = %d", rec.Code)
	}

	// 다시 열어도 요청과 학습 기록이 남고, 모델을 지워도 둘은 그대로입니다
	if rec := f.do("DELETE", "/api/admin/ai/dots", "", "", admin); rec.Code != http.StatusOK {
		t.Fatalf("delete model = %d", rec.Code)
	}
	again, err := Open(f.dir)
	if err != nil {
		t.Fatal(err)
	}
	if r, ok := again.RequestOf("dots"); !ok || r.Status != StatusDone {
		t.Errorf("reopened dots request = %+v", r)
	}
	if r, ok := again.RequestOf("dots2"); !ok || r.Status != StatusDeclined || r.Note == "" {
		t.Errorf("reopened dots2 request = %+v", r)
	}
	if info, ok := again.TrainingOf("dots"); !ok || info.Snapshots != 2 {
		t.Errorf("reopened training = %+v", info)
	}
	if again.Model("dots") != nil {
		t.Error("deleted model came back")
	}
	if list := again.Requests(); len(list) != 2 || list[0].Game != "dots2" {
		t.Errorf("closed requests, latest first = %+v", list)
	}

	// 내린 게임은 요청할 수 없습니다
	g := f.games["dots2"]
	g.Hidden = true
	f.games["dots2"] = g
	if c := ask("dots2", creator); c != http.StatusConflict {
		t.Errorf("hidden game = %d", c)
	}
}

func TestTrainingChecks(t *testing.T) {
	f := setup(t)
	f.games.add("dots", f.member.ID, dotsVersion)
	edit := func(change func(m map[string]any)) string {
		var m map[string]any
		json.Unmarshal([]byte(snapshotsJSON), &m)
		change(m)
		out, _ := json.Marshal(m)
		return string(out)
	}
	snap := func(m map[string]any, i int) map[string]any { return m["snapshots"].([]any)[i].(map[string]any) }
	game := func(m map[string]any) map[string]any { return snap(m, 0)["games"].([]any)[0].(map[string]any) }
	for name, body := range map[string]string{
		"not JSON":     "{",
		"format":       edit(func(m map[string]any) { m["format"] = 2 }),
		"other game":   edit(func(m map[string]any) { m["game"] = "tictactoe" }),
		"version":      edit(func(m map[string]any) { m["version"] = "abc" }),
		"no snapshots": edit(func(m map[string]any) { m["snapshots"] = []any{} }),
		"minute":       edit(func(m map[string]any) { snap(m, 0)["minute"] = -1 }),
		"selfplay":     edit(func(m map[string]any) { snap(m, 1)["selfplay"].(map[string]any)["draws"] = 9999 }),
		"accuracy": edit(func(m map[string]any) {
			snap(m, 1)["eval"].(map[string]any)["accuracy"] = map[string]any{"policy": 2, "search": 0}
		}),
		"winner": edit(func(m map[string]any) { game(m)["winner"] = 2 }),
		"reason": edit(func(m map[string]any) { game(m)["reason"] = "resign" }),
		"player": edit(func(m map[string]any) { game(m)["moves"].([]any)[0].(map[string]any)["player"] = 2 }),
		"action": edit(func(m map[string]any) {
			game(m)["moves"] = []any{map[string]any{"player": 0, "action": map[string]any{"kind": "click", "row": 40, "col": 0}}}
		}),
		"many games": edit(func(m map[string]any) {
			games := []any{}
			for range MaxShowGames + 1 {
				games = append(games, game(m))
			}
			snap(m, 0)["games"] = games
		}),
	} {
		rec := f.do("PUT", "/api/admin/ai/dots/training", "application/json", body, &f.boss)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Errorf("%s = %d %s, want 422", name, rec.Code, rec.Body)
		}
	}
	if rec := f.do("PUT", "/api/admin/ai/dots/training", "application/json", `{"pad":"`+strings.Repeat("x", MaxTraining)+`"}`, &f.boss); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("too big = %d", rec.Code)
	}
	if rec := f.do("PUT", "/api/admin/ai/nope/training", "application/json", snapshotsJSON, &f.boss); rec.Code != http.StatusNotFound {
		t.Errorf("unknown game = %d", rec.Code)
	}
	if _, ok := f.store.TrainingOf("dots"); ok {
		t.Error("a bad upload was saved")
	}
}
