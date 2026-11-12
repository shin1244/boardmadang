package admin

import (
	"cmp"
	"net/http"
	"slices"
	"strconv"

	"github.com/shin1244/boardmadang/server/internal/stats"
)

// GET /api/admin/stats?days=30 은 운영자 화면 위쪽의 숫자와 그래프입니다. 날짜는 모두 한국 날짜(KST)입니다.
//
// 방문(DAU, MAU)과 AI 대국은 internal/stats가 새로 세고, 나머지는 원래 남기던 것에서 셉니다.
// 대국은 기보 저장소의 날마다 판 수(로비 인기순과 같은 기준), 등록은 올린 게임의 등록 기록, 가입은 계정의 가입 시각입니다.
// AI 대국은 브라우저 안에서만 돌아 기보가 없으므로, AI 화면이 알려 준 판 수입니다 (stats의 ai.go).

const (
	DefaultStatsDays = 30  // days를 안 주면
	MaxStatsDays     = 365 // days의 최대
	TopGames         = 10  // 많이 둔 게임을 몇 개까지
)

// Stats는 GET /api/admin/stats의 응답입니다.
type Stats struct {
	Today string     `json:"today"`
	Days  []DayStats `json:"days"` // 오래된 날부터 days일, 마지막이 오늘 (오늘은 지금까지)
	// 방문을 세기 시작한 날. 그 앞 날의 방문은 0입니다. 아직 아무도 오지 않았으면 ""
	VisitsSince string    `json:"visitsSince"`
	Online      int       `json:"online"`   // 지금 웹소켓이 열려 있는 사람
	Playing     int       `json:"playing"`  // 지금 진행 중인 대국
	Accounts    int       `json:"accounts"` // 지금 있는 계정 수
	Uploads     int       `json:"uploads"`  // 지금까지 올린 게임 수 (내린 게임 포함)
	Top         []TopGame `json:"top"`      // 이 기간에 많이 둔 게임 (온라인 + AI, TopGames개까지)
}

// DayStats는 하루의 수입니다.
type DayStats struct {
	Day        string `json:"day"`
	Visitors   int    `json:"visitors"`   // 온 사람 (계정 + 게스트). DAU
	Members    int    `json:"members"`    // 그중 계정
	MAU        int    `json:"mau"`        // 그날까지 30일 동안 온 사람
	MAUMembers int    `json:"mauMembers"` // 그중 계정
	Plays      int    `json:"plays"`      // 끝난 대국 (무효, 혼자 둔 대국, 한 수도 안 둔 대국은 빼고)
	AIPlays    int    `json:"aiPlays"`    // AI와 둔 판 (사람이 한 수 이상 둔 판)
	AIEnds     int    `json:"aiEnds"`     // 그중 끝까지 둔 판 (기권 포함)
	AIWins     int    `json:"aiWins"`     // 끝난 판 중 사람이 이긴 판
	AIDraws    int    `json:"aiDraws"`    // 끝난 판 중 비긴 판 (나머지는 AI가 이김)
	NewGames   int    `json:"newGames"`   // 처음 등록된 게임
	Updates    int    `json:"updates"`    // 이미 있던 게임을 다시 등록한 것 (새 버전이나 등록 정보)
	Signups    int    `json:"signups"`    // 가입 (그 뒤 탈퇴한 계정은 빠집니다)
}

// TopGame은 기간 동안 둔 판 수가 많은 게임입니다. 온라인과 AI 판을 더한 수로 줄 세웁니다.
type TopGame struct {
	Game    string `json:"game"`
	Plays   int    `json:"plays"`   // 온라인 대국
	AIPlays int    `json:"aiPlays"` // AI와 둔 판
}

// Stats는 오늘까지 n일의 통계입니다. 저장소가 없는 칸은 0입니다.
func (h *Handler) Stats(n int) Stats {
	today := stats.Day(h.now())
	from := stats.AddDays(today, -(n - 1))
	out := Stats{Today: today, Days: make([]DayStats, n), Top: []TopGame{}}
	index := make(map[string]*DayStats, n)
	for i := range out.Days {
		d := &out.Days[i]
		d.Day = stats.AddDays(from, i)
		index[d.Day] = d
	}

	top := make(map[string]*TopGame)
	topOf := func(game string) *TopGame {
		if top[game] == nil {
			top[game] = &TopGame{Game: game}
		}
		return top[game]
	}
	if h.Visits != nil {
		visits, since := h.Visits.Range(n)
		out.VisitsSince = since
		for _, v := range visits {
			if d := index[v.Day]; d != nil {
				d.Visitors, d.Members, d.MAU, d.MAUMembers = v.Visitors, v.Members, v.MAU, v.MAUMembers
			}
		}
		for day, games := range h.Visits.AIDaily(from) {
			d := index[day]
			if d == nil {
				continue
			}
			for game, c := range games {
				d.AIPlays += c.Plays
				d.AIEnds += c.Ends
				d.AIWins += c.Wins
				d.AIDraws += c.Draws
				if c.Plays > 0 {
					topOf(game).AIPlays += c.Plays
				}
			}
		}
	}
	if h.Records != nil {
		for day, games := range h.Records.Daily(from) {
			d := index[day]
			if d == nil {
				continue // 시계가 틀린 기보 (오늘보다 뒤)
			}
			for game, plays := range games {
				d.Plays += plays
				topOf(game).Plays += plays
			}
		}
	}
	for _, g := range top {
		out.Top = append(out.Top, *g)
	}
	slices.SortFunc(out.Top, func(a, b TopGame) int {
		return cmp.Or(cmp.Compare(b.Plays+b.AIPlays, a.Plays+a.AIPlays), cmp.Compare(a.Game, b.Game))
	})
	out.Top = out.Top[:min(len(out.Top), TopGames)]
	if h.Uploads != nil {
		for _, r := range h.Uploads.Releases() {
			if r.First {
				out.Uploads++
			}
			d := index[stats.Day(r.At)]
			switch {
			case d == nil:
			case r.First:
				d.NewGames++
			default:
				d.Updates++
			}
		}
	}
	if h.Accounts != nil {
		joined := h.Accounts.Joined()
		out.Accounts = len(joined)
		for _, at := range joined {
			if d := index[stats.Day(at)]; d != nil {
				d.Signups++
			}
		}
	}
	if h.Live != nil {
		out.Online, out.Playing = h.Live()
	}
	return out
}

func (h *Handler) ServeStats(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.admin(w, r); !ok {
		return
	}
	n := DefaultStatsDays
	if q := r.URL.Query().Get("days"); q != "" {
		v, err := strconv.Atoi(q)
		if err != nil || v < 1 || v > MaxStatsDays {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad days"})
			return
		}
		n = v
	}
	writeJSON(w, http.StatusOK, h.Stats(n))
}
