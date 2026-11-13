package upload

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"unicode/utf16"
	"unicode/utf8"
)

// 썸네일 검사. sdk/check.js의 validateThumbnail, normalizeThumbnail과 같은 규칙입니다. 한쪽을 고치면 같이 고칩니다.
// 썸네일은 이미지가 아니라 판 설정, 기물 세트, 화면 데이터라서 로비가 보드 렌더러로 다시 그립니다.
// 모든 방문자의 로비에 그려지므로 서버가 모양과 크기를 지킵니다. 게임 코드와 맞는지(checkThumbnail)는 등록창이 실행기 안에서 봅니다.

// ThumbnailBytes는 정리한 썸네일 JSON의 상한입니다 (GAME_LIMITS.thumbnailBytes).
const ThumbnailBytes = 32 << 10

const (
	boardSize  = 32 // GAME_LIMITS.boardSize
	pieceKinds = 32 // GAME_LIMITS.pieceKinds
)

// 테두리(frame 표시)와 선(lines)의 두께 범위. 칸 한 변의 %입니다 (sdk/playground/board.js의 FRAME_WIDTH, LINE_WIDTH).
var (
	frameWidth = [2]float64{1, 30}
	lineWidth  = [2]float64{1, 50}
)

var (
	places    = []string{"cells", "points", "both"}
	pieceSets = []string{"chess", "go-stones", "xo"}
	markTypes = []string{"dot", "ring", "last-move", "danger", "ghost", "blocked", "frame"}
	hexColor  = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
)

// CheckThumbnail은 thumbnail.json을 검사합니다. 문제가 없으면 정리한 JSON을, 있으면 문제 글(영어, check.js와 같은 글)을 돌려줍니다.
func CheckThumbnail(data []byte) (json.RawMessage, []string) {
	var v any
	if err := json.Unmarshal(data, &v); err != nil {
		return nil, []string{"thumbnail.json is not valid JSON"}
	}
	if _, isList := v.([]any); isList {
		v = map[string]any{} // 자바스크립트에서는 배열도 객체라 칸마다 검사합니다
	}
	t, ok := v.(map[string]any)
	if !ok {
		return nil, []string{"thumbnail: must be an object"}
	}
	p := boardProblems(t["board"], "thumbnail.board")
	if !piecesOk(t["pieces"]) {
		p = append(p, "thumbnail.pieces: must look like the game's pieces")
	}
	if player, ok := t["player"].(float64); !ok || (player != 0 && player != 1) {
		p = append(p, "thumbnail.player: must be 0 or 1")
	}
	view, ok := t["view"].(map[string]any)
	if _, isList := view["pieces"].([]any); !ok || !isList {
		p = append(p, "thumbnail.view.pieces: must be a list")
	}
	if len(p) > 0 {
		return nil, p
	}

	b := t["board"].(map[string]any)
	rows, cols := b["rows"].(float64), b["cols"].(float64)
	for _, k := range []string{"marks", "tint", "text", "lines"} {
		if x, present := view[k]; present {
			if _, isList := x.([]any); !isList {
				p = append(p, fmt.Sprintf("thumbnail.view.%s: must be a list if present", k))
			}
		}
	}
	if len(p) > 0 {
		return nil, p
	}
	isCell := func(c map[string]any) bool {
		if c == nil {
			return false
		}
		r, okR := whole(c["row"])
		col, okC := whole(c["col"])
		return okR && okC && r >= 0 && col >= 0 && r < rows && col < cols
	}
	items := func(k string) []map[string]any {
		list, _ := view[k].([]any)
		out := make([]map[string]any, len(list))
		for i, x := range list {
			out[i], _ = x.(map[string]any) // 객체가 아니면 nil이라 isCell에서 걸립니다
		}
		return out
	}
	every := func(k string, ok func(map[string]any) bool) bool {
		return !slices.ContainsFunc(items(k), func(x map[string]any) bool { return !ok(x) })
	}
	if !every("pieces", func(x map[string]any) bool {
		s, isStr := x["piece"].(string)
		return isCell(x) && isStr && jsLen(s) <= 32
	}) {
		p = append(p, "thumbnail.view.pieces: each needs a place on the board and a piece name")
	}
	if !every("marks", func(m map[string]any) bool {
		_, isStr := m["piece"].(string)
		return isCell(m) && slices.Contains(markTypes, str(m["type"])) &&
			(!has(m, "piece") || isStr) && (!has(m, "color") || isColor(m["color"])) && isWidth(m, frameWidth)
	}) {
		p = append(p, "thumbnail.view.marks: each needs a place on the board and a known mark type")
	}
	if !every("tint", func(x map[string]any) bool {
		hover, _ := x["hover"].(map[string]any)
		return isCell(x) && isColor(x["color"]) && (!has(x, "hover") || isCell(hover))
	}) {
		p = append(p, "thumbnail.view.tint: each needs a place on the board and a color")
	}
	if !every("text", func(x map[string]any) bool {
		s, isStr := x["text"].(string)
		return isCell(x) && isStr && jsLen(s) <= 8
	}) {
		p = append(p, "thumbnail.view.text: each needs a place on the board and up to 8 characters")
	}
	if !every("lines", func(l map[string]any) bool {
		from, _ := l["from"].(map[string]any)
		to, _ := l["to"].(map[string]any)
		hover, _ := l["hover"].(map[string]any)
		return l != nil && isCell(from) && isCell(to) && (!has(l, "color") || isColor(l["color"])) &&
			isWidth(l, lineWidth) && (!has(l, "hover") || isCell(hover))
	}) {
		p = append(p, fmt.Sprintf("thumbnail.view.lines: each needs from and to on the board, and width from %g to %g", lineWidth[0], lineWidth[1]))
	}
	if len(p) > 0 {
		return nil, p
	}

	// normalizeThumbnail: 알려진 칸만 남깁니다
	cell := func(x map[string]any) map[string]any { return map[string]any{"row": x["row"], "col": x["col"]} }
	board := map[string]any{"places": b["places"], "rows": b["rows"], "cols": b["cols"]}
	for _, k := range []string{"look", "starPoints", "labels", "flipForPlayer"} {
		if has(b, k) {
			board[k] = b[k]
		}
	}
	// 판 밖 영역은 알려진 칸만 (boardProblems를 통과했으면 맞는 값입니다)
	if areas, _ := areasOf(b); areas != nil {
		board["areas"] = areas
	}
	out := map[string]any{}
	pieces := []any{}
	for _, x := range items("pieces") {
		c := cell(x)
		c["piece"] = x["piece"]
		pieces = append(pieces, c)
	}
	out["pieces"] = pieces
	if _, present := view["marks"]; present {
		marks := []any{}
		for _, m := range items("marks") {
			c := cell(m)
			c["type"] = m["type"]
			for _, k := range []string{"piece", "color", "width"} {
				if has(m, k) {
					c[k] = m[k]
				}
			}
			marks = append(marks, c)
		}
		out["marks"] = marks
	}
	for k, field := range map[string]string{"tint": "color", "text": "text"} {
		if _, present := view[k]; present {
			list := []any{}
			for _, x := range items(k) {
				if k == "tint" && has(x, "hover") {
					continue // 마우스를 올렸을 때만 보이는 칠하기는 썸네일에 넣지 않습니다
				}
				c := cell(x)
				c[field] = x[field]
				list = append(list, c)
			}
			out[k] = list
		}
	}
	// 마우스를 올렸을 때만 보이는 선(hover)은 썸네일에 넣지 않습니다
	if _, present := view["lines"]; present {
		lines := []any{}
		for _, l := range items("lines") {
			if has(l, "hover") {
				continue
			}
			from, to := l["from"].(map[string]any), l["to"].(map[string]any)
			c := map[string]any{"from": cell(from), "to": cell(to)}
			for _, k := range []string{"color", "width"} {
				if has(l, k) {
					c[k] = l[k]
				}
			}
			lines = append(lines, c)
		}
		out["lines"] = lines
	}
	norm := map[string]any{"board": board, "pieces": t["pieces"], "player": t["player"], "view": out}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // 크기를 JSON.stringify와 비슷하게 셉니다
	if err := enc.Encode(norm); err != nil {
		return nil, []string{"thumbnail: " + err.Error()}
	}
	data = bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	if len(data) > ThumbnailBytes {
		return nil, []string{fmt.Sprintf("thumbnail is larger than %dKB", ThumbnailBytes>>10)}
	}
	return data, nil
}

// boardProblems: places와 1~32의 rows, cols (check.js의 boardProblems)
func boardProblems(v any, where string) []string {
	b, ok := v.(map[string]any)
	if !ok {
		return []string{where + ": must be an object"}
	}
	var p []string
	if !slices.Contains(places, str(b["places"])) {
		p = append(p, where+".places: must be 'cells', 'points', or 'both'")
	}
	for _, k := range []string{"rows", "cols"} {
		if n, ok := whole(b[k]); !ok || n < 1 || n > boardSize {
			p = append(p, fmt.Sprintf("%s.%s: must be a whole number from 1 to %d", where, k, boardSize))
		}
	}
	// 판 밖 영역은 rows, cols가 맞을 때만 봅니다
	if len(p) == 0 {
		if _, msg := areasOf(b); msg != "" {
			p = append(p, where+"."+msg)
		}
	}
	return p
}

// 판 밖 영역(board.areas)이 붙는 쪽과 최대 개수 (sdk/playground/board.js의 AREA_SIDES, MAX_AREAS)
var areaSides = []string{"top", "bottom", "left", "right"}

const maxAreas = 8

// areasOf는 판 밖 영역을 검사하고 알려진 칸만 남긴 목록을 돌려줍니다. 문제가 있으면 그 글(check.js와 같은 글)입니다.
// sdk/playground/board.js의 fieldOf와 같은 규칙입니다: 판은 영역을 뺀 가운데 직사각형이고, 영역끼리 겹치면 안 됩니다.
// rows, cols는 이미 검사한 값이어야 합니다. areas가 없으면 nil, "".
func areasOf(b map[string]any) ([]any, string) {
	if !has(b, "areas") {
		return nil, ""
	}
	rows, cols := b["rows"].(float64), b["cols"].(float64)
	list, ok := b["areas"].([]any)
	if !ok || len(list) > maxAreas {
		return nil, fmt.Sprintf("areas: must be a list of up to %d areas", maxAreas)
	}
	type rect struct{ row, col, rows, cols float64 }
	var rects []rect
	out := []any{}
	top, bottom, left, right := 0.0, rows, 0.0, cols
	for i, x := range list {
		a, _ := x.(map[string]any)
		side := str(a["side"])
		r, okR := whole(a["row"])
		c, okC := whole(a["col"])
		h, okH := whole(a["rows"])
		w, okW := whole(a["cols"])
		if a == nil || !slices.Contains(areaSides, side) || !okR || !okC || !okH || !okW ||
			r < 0 || r > rows-1 || c < 0 || c > cols-1 || h < 1 || h > rows-r || w < 1 || w > cols-c {
			return nil, fmt.Sprintf("areas[%d]: needs side ('top', 'bottom', 'left', 'right') and row, col, rows, cols that stay inside the board", i)
		}
		switch side {
		case "top":
			top = math.Max(top, r+h)
		case "bottom":
			bottom = math.Min(bottom, r)
		case "left":
			left = math.Max(left, c+w)
		case "right":
			right = math.Min(right, c)
		}
		rects = append(rects, rect{r, c, h, w})
		out = append(out, map[string]any{"side": side, "row": a["row"], "col": a["col"], "rows": a["rows"], "cols": a["cols"]})
	}
	if top >= bottom || left >= right {
		return nil, "areas: leave the board in the middle (top areas above it, bottom below, left and right beside it)"
	}
	for i := range rects {
		for j := i + 1; j < len(rects); j++ {
			a, o := rects[i], rects[j]
			if a.row < o.row+o.rows && o.row < a.row+a.rows && a.col < o.col+o.cols && o.col < a.col+a.cols {
				return nil, fmt.Sprintf("areas[%d] and areas[%d] overlap", i, j)
			}
		}
	}
	return out, ""
}

func piecesOk(v any) bool {
	if s, ok := v.(string); ok {
		return slices.Contains(pieceSets, s)
	}
	list, ok := v.([]any)
	return ok && len(list) <= pieceKinds && !slices.ContainsFunc(list, func(x any) bool { return !pieceOk(x) })
}

// tileArrows는 글자 패의 방향입니다 (sdk/playground/board.js의 TILE_ARROWS).
var tileArrows = []string{"n", "ne", "e", "se", "s", "sw", "w", "nw"}

// pieceOk는 기물 목록의 한 항목이 이름이거나 글자 패 { name, text, player?, arrows? }인지입니다 (글자 패는 sdk/playground/board.js의 cleanPiece와 같은 규칙).
func pieceOk(x any) bool {
	if _, ok := x.(string); ok {
		return true
	}
	m, ok := x.(map[string]any)
	if !ok {
		return false
	}
	name, ok := m["name"].(string)
	if !ok || name == "" || len(utf16.Encode([]rune(name))) > 32 {
		return false
	}
	text, ok := m["text"].(string)
	if n := utf8.RuneCountInString(text); !ok || n < 1 || n > 2 {
		return false
	}
	if has(m, "player") {
		if p, ok := m["player"].(float64); !ok || (p != 0 && p != 1) {
			return false
		}
	}
	if has(m, "arrows") {
		arrows, ok := m["arrows"].([]any)
		if !ok {
			return false
		}
		seen := map[string]bool{}
		for _, a := range arrows {
			s, ok := a.(string)
			if !ok || !slices.Contains(tileArrows, s) || seen[s] {
				return false
			}
			seen[s] = true
		}
	}
	return true
}

// isWidth는 두께(width)가 없거나 범위 안의 숫자인지입니다.
func isWidth(m map[string]any, r [2]float64) bool {
	if !has(m, "width") {
		return true
	}
	w, ok := m["width"].(float64)
	return ok && w >= r[0] && w <= r[1]
}

func isColor(v any) bool {
	if n, ok := v.(float64); ok {
		return n == 0 || n == 1
	}
	s, ok := v.(string)
	return ok && (hexColor.MatchString(s) || slices.Contains(colorNames, s))
}

// colorNames는 게임이 쓸 수 있는 이름 붙은 색입니다 (sdk/playground/board.js의 NAMED_COLORS와 같아야 함).
var colorNames = []string{"green", "yellow", "gray"}

// whole은 Number.isInteger입니다.
func whole(v any) (float64, bool) {
	n, ok := v.(float64)
	return n, ok && n == math.Trunc(n) && !math.IsInf(n, 0)
}

// has는 키가 있는지입니다. 자바스크립트의 x[k] !== undefined (null은 있는 것으로 봅니다).
func has(m map[string]any, k string) bool {
	_, ok := m[k]
	return ok
}
