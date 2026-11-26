// dbexport는 서버가 DATA_DIR에 남긴 파일(기보, 계정, 의견, 방문 기록 등)을 읽어 분석용 SQLite 파일 하나로 만듭니다.
// 표의 모양은 schema.sql에, 쓰는 방법과 분석 쿼리 예시는 analysis/README.md에 있습니다.
//
//	cd server
//	go run ./cmd/dbexport                             # 개발 서버의 data/ → ../analysis/boardmadang.db
//	go run ./cmd/dbexport -data ../analysis/data      # 운영 서버에서 받아 온 복사본
//
// DATA_DIR는 읽기만 합니다. 돌릴 때마다 결과 파일을 새로 만듭니다.
// 켜져 있는 서버의 폴더를 바로 읽어도 되지만, 그 사이에 쓰이는 파일은 빠질 수 있습니다.
package main

import (
	"cmp"
	"flag"
	"fmt"
	"log"
	"maps"
	"os"
	"slices"
	"time"
)

func main() {
	log.SetFlags(0)
	data := flag.String("data", cmp.Or(os.Getenv("DATA_DIR"), "data"), "서버의 DATA_DIR 폴더")
	site := flag.String("site", cmp.Or(os.Getenv("SITE_DIR"), ".."), "레포 루트 (games/의 게임 이름을 읽습니다)")
	out := flag.String("out", "../analysis/boardmadang.db", "만들 SQLite 파일. 있으면 새로 만듭니다")
	flag.Parse()

	sum, err := Export(*data, *site, *out, time.Now())
	if err != nil {
		log.Fatalf("만들지 못했습니다: %v", err)
	}
	fmt.Printf("%s를 만들었습니다.\n", *out)
	for _, table := range slices.Sorted(maps.Keys(sum.Rows)) {
		fmt.Printf("  %-14s %d줄\n", table, sum.Rows[table])
	}
	if len(sum.Skipped) > 0 {
		fmt.Printf("읽지 못해 건너뛴 것 %d개:\n", len(sum.Skipped))
		for _, s := range sum.Skipped {
			fmt.Printf("  %s\n", s)
		}
	}
}
