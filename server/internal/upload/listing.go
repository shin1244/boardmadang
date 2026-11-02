package upload

import (
	"math"
	"slices"
	"strings"
	"unicode"
)

// 등록 정보 검사. sdk/playground/listing.js의 validateListing, normalizeListing과 같은 규칙입니다. 한쪽을 고치면 같이 고칩니다.
// 등록창도 같은 검사를 하지만 서버는 화면을 믿지 않고 저장하기 전에 다시 합니다.

// Langs는 플랫폼이 지원하는 언어입니다 (listing.js의 LANGS).
var Langs = []string{"ko", "en", "ja", "zh", "es", "fr", "de", "pt", "ru", "ar"}

var (
	supports     = []string{"full", "rulebook"}
	difficulties = []string{"easy", "normal", "hard"}
	textFields   = []string{"name", "description", "rulebook"}
	textLimits   = map[string]int{"name": 40, "description": 200, "rulebook": 20000}
)

const timerMin, timerMax = 1, 180

// Problem은 고쳐야 올릴 수 있는 문제 하나입니다. 글자는 화면이 code로 고릅니다 (web/i18n.js의 problem.*, upload.*).
type Problem struct {
	Code  string `json:"code"`
	Field string `json:"field,omitempty"`
	Lang  string `json:"lang,omitempty"`
	File  string `json:"file,omitempty"`
	Min   int    `json:"min,omitempty"`
	Max   int    `json:"max,omitempty"`
}

// Problems는 문제 목록이자 에러입니다. HTTP로는 422 {"error":"problems","problems":[...]}입니다.
type Problems []Problem

func (p Problems) Error() string { return "problems: " + p[0].Code }

// Listing은 저장하는 등록 정보입니다 (normalizeListing의 결과).
type Listing struct {
	Languages   map[string]string `json:"languages"`
	Difficulty  string            `json:"difficulty"`
	Timer       Timer             `json:"timer"`
	Name        map[string]string `json:"name"`
	Description map[string]string `json:"description"`
	Rulebook    map[string]string `json:"rulebook"`
}

type Timer struct {
	Minutes *int `json:"minutes"` // null이면 타이머 없음
	Custom  bool `json:"custom"`
}

// CheckListing은 JSON을 풀어 둔 등록 정보(v)를 검사합니다. 문제가 없으면 저장할 모양으로 정리해 돌려줍니다.
// 지원하지 않는 언어로 쓴 글은 문제로 보지 않고 버립니다. 문제 순서는 LANGS 순입니다 (화면은 등록 정보에 적힌 순).
func CheckListing(v any) (Listing, Problems) {
	if _, isList := v.([]any); isList {
		v = map[string]any{} // 자바스크립트에서는 배열도 객체라 칸마다 검사합니다
	}
	l, ok := v.(map[string]any)
	if !ok {
		return Listing{}, Problems{{Code: "languages.none"}}
	}
	var problems Problems

	langs, _ := l["languages"].(map[string]any)
	invalid, hasFull := false, false
	for lang, s := range langs {
		if !slices.Contains(Langs, lang) || !slices.Contains(supports, str(s)) {
			invalid = true
		}
		hasFull = hasFull || str(s) == "full"
	}
	var supported []string
	for _, lang := range Langs {
		if slices.Contains(supports, str(langs[lang])) {
			supported = append(supported, lang)
		}
	}
	if invalid {
		problems = append(problems, Problem{Code: "languages.invalid"})
	}
	if len(supported) == 0 {
		problems = append(problems, Problem{Code: "languages.none"})
	} else if !hasFull {
		problems = append(problems, Problem{Code: "languages.needFull"})
	}

	difficulty := str(l["difficulty"])
	if !slices.Contains(difficulties, difficulty) {
		problems = append(problems, Problem{Code: "difficulty.invalid"})
	}

	timer, ok := readTimer(l["timer"])
	if !ok {
		problems = append(problems, Problem{Code: "timer.invalid", Min: timerMin, Max: timerMax})
	}

	texts := map[string]map[string]string{}
	for _, field := range textFields {
		texts[field] = map[string]string{}
		byLang, _ := l[field].(map[string]any)
		for _, lang := range supported {
			s, isStr := byLang[lang].(string)
			switch {
			case !isStr || jsTrim(s) == "":
				problems = append(problems, Problem{Code: "text.missing", Field: field, Lang: lang})
			case jsLen(s) > textLimits[field]:
				problems = append(problems, Problem{Code: "text.tooLong", Field: field, Lang: lang, Max: textLimits[field]})
			default:
				texts[field][lang] = jsTrim(s)
			}
		}
	}
	if len(problems) > 0 {
		return Listing{}, problems
	}

	out := Listing{Languages: map[string]string{}, Difficulty: difficulty, Timer: timer,
		Name: texts["name"], Description: texts["description"], Rulebook: texts["rulebook"]}
	for _, lang := range supported {
		out.Languages[lang] = str(langs[lang])
	}
	return out, nil
}

// readTimer: minutes는 1~180의 정수 또는 null, custom은 true/false (listing.js의 validMinutes).
func readTimer(v any) (Timer, bool) {
	t, ok := v.(map[string]any)
	if !ok {
		return Timer{}, false
	}
	custom, ok := t["custom"].(bool)
	if !ok {
		return Timer{}, false
	}
	m, present := t["minutes"]
	if !present {
		return Timer{}, false // undefined는 null과 다릅니다
	}
	if m == nil {
		return Timer{Custom: custom}, true
	}
	f, ok := m.(float64)
	if !ok || f != math.Trunc(f) || f < timerMin || f > timerMax {
		return Timer{}, false
	}
	minutes := int(f)
	return Timer{Minutes: &minutes, Custom: custom}, true
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// jsLen은 자바스크립트의 String.length (UTF-16 단위 수)입니다. 글자 수 제한을 화면과 똑같이 셉니다.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

// jsTrim은 자바스크립트의 String.trim()입니다. Go의 TrimSpace와 달리 U+0085는 남기고 U+FEFF는 지웁니다.
func jsTrim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool {
		return r == 0xFEFF || (unicode.IsSpace(r) && r != '\u0085')
	})
}
