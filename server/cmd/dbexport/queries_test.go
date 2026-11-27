package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/stats"
)

// analysis/queries.sql의 쿼리가 모두 지금의 표 모양으로 돌아가는지 봅니다.
// 표나 칸 이름을 바꾸면 이 테스트가 먼저 알려 줍니다.
func TestQueriesRun(t *testing.T) {
	file := filepath.Join("..", "..", "..", "analysis", "queries.sql")
	src, err := os.ReadFile(file)
	if err != nil {
		t.Skipf("%s 없음: %v", file, err)
	}
	data, site, _, _ := fixture(t)
	out := filepath.Join(t.TempDir(), "out.db")
	if _, err := Export(data, site, out, time.Date(2026, 11, 26, 12, 0, 0, 0, stats.KST)); err != nil {
		t.Fatal(err)
	}
	db := open(t, out)

	// 줄 전체가 주석인 줄을 빼고 ;로 나눕니다 (문자열과 주석 안에 ;를 쓰지 않습니다)
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(string(src), "\r\n", "\n"), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "--") {
			lines = append(lines, line)
		}
	}
	n := 0
	for _, q := range strings.Split(strings.Join(lines, "\n"), ";") {
		if q = strings.TrimSpace(q); q == "" {
			continue
		}
		n++
		rows, err := db.Query(q)
		if err != nil {
			t.Errorf("query %d: %v\n%s", n, err, q)
			continue
		}
		for rows.Next() {
		}
		if err := rows.Err(); err != nil {
			t.Errorf("query %d: %v\n%s", n, err, q)
		}
		rows.Close()
	}
	if n == 0 {
		t.Fatal("no queries found")
	}
	t.Logf("%d queries ran", n)
}
