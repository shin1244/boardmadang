-- 보드마당 분석용 데이터베이스. server/cmd/dbexport가 DATA_DIR의 파일을 읽어 만듭니다 (analysis/README.md).
--
-- 시각은 모두 한국 시간 'YYYY-MM-DD HH:MM:SS', 날짜는 한국 날짜 'YYYY-MM-DD'입니다 (하루는 한국 시각 0시부터).
-- 참/거짓은 1/0입니다. 사람 id는 계정이 m_, 게스트가 g_로 시작합니다.
-- 로그인한 곳의 사용자 번호(sub), 신고와 운영 기록, 게임 코드는 넣지 않습니다.

-- 내보낸 때 같은 정보
CREATE TABLE export_info (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 게임. 대국, 의견, 즐겨찾기에 나오는 게임은 모두 있습니다 (코드를 찾지 못한 게임은 source가 unknown)
CREATE TABLE games (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL,              -- repo(레포 games/), private(games/private/), upload(회원이 올림), unknown
  name_ko    TEXT,
  name_en    TEXT,
  difficulty TEXT,
  owner_id   TEXT,                       -- 올린 사람의 계정 id (올린 게임만)
  version    TEXT,                       -- 지금 버전 (올린 게임만)
  created_at TEXT,                       -- 처음 등록한 때 (올린 게임만)
  hidden     INTEGER NOT NULL DEFAULT 0, -- 주인이 내림
  blocked    INTEGER NOT NULL DEFAULT 0  -- 운영자가 내림
);

-- 올린 게임을 등록한 기록. 같은 버전을 다시 등록해도 한 줄씩 (업데이트 전후 비교에 씁니다)
CREATE TABLE game_releases (
  game_id      TEXT NOT NULL,
  version      TEXT NOT NULL,
  published_at TEXT NOT NULL
);

-- 계정. 탈퇴한 계정은 없습니다
CREATE TABLE accounts (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,             -- google, github
  name        TEXT NOT NULL,             -- 지금 이름
  created_at  TEXT NOT NULL,
  created_day TEXT NOT NULL,
  renamed_at  TEXT,                      -- 마지막으로 이름을 바꾼 때
  suspended   INTEGER NOT NULL           -- 내보낸 때 정지 중인지
);

-- 끝난 대국 하나. 무효가 된 대국도 있습니다 (counted로 거릅니다)
CREATE TABLE matches (
  id             TEXT PRIMARY KEY,       -- 다시보기 주소 /web/replay.html?id=<id>
  game_id        TEXT NOT NULL,
  version        TEXT,                   -- 게임 코드 버전
  timer_minutes  INTEGER,                -- 타이머(분). NULL이면 없음
  started_at     TEXT,
  ended_at       TEXT NOT NULL,
  day            TEXT NOT NULL,          -- 끝난 날
  duration_sec   REAL,                   -- 시작부터 끝까지
  actions        INTEGER NOT NULL,       -- 행동 수. 게임이 무시한 클릭도 들어 있어 "둔 수"보다 많을 수 있습니다
  reason         TEXT NOT NULL,          -- 끝난 이유: result(규칙대로 끝남), resign(기권), timeout(시간패), left(나감),
                                         -- agreed(무승부 합의), spam(무시된 행동이 너무 많음), desync/disagree/limit(무효),
                                         -- shutdown(서버를 끄느라 끝냄, 무효)
  winner         INTEGER,                -- 이긴 자리 0(선공) 또는 1(후공). NULL이면 무승부나 무효
  counted        INTEGER NOT NULL,       -- 판 수에 세는 대국인지. 무효, 행동 없음, 한 사람이 두 자리에 앉은 대국은 0 (로비 인기순과 같은 기준)
  clock_left0_ms INTEGER,                -- 끝났을 때 선공에게 남은 시간 (타이머가 있을 때)
  clock_left1_ms INTEGER
);
CREATE INDEX matches_game ON matches (game_id);
CREATE INDEX matches_day ON matches (day);

-- 대국에 앉은 사람. 대국마다 두 줄 (seat 0 = 선공, 1 = 후공. 선후공은 대국마다 무작위)
CREATE TABLE match_players (
  match_id  TEXT NOT NULL,
  seat      INTEGER NOT NULL,
  player_id TEXT NOT NULL,                -- 탈퇴한 사람은 gone, gone-0, gone-1
  kind      TEXT NOT NULL,                -- member, guest, gone
  name      TEXT,                         -- 그때의 계정 이름 (계정만)
  country   TEXT,                         -- 대국을 시작할 때 접속한 나라 (KR, US, …). 모르거나 이 기능 전의 대국이면 NULL
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX match_players_player ON match_players (player_id);

-- 대국의 행동 하나하나 (기보)
CREATE TABLE match_actions (
  match_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,              -- 0부터
  seat     INTEGER NOT NULL,              -- 행동한 자리
  kind     TEXT NOT NULL,                 -- click 또는 게임의 특수 행동 (pass 등)
  row      INTEGER NOT NULL,
  col      INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL,              -- 대국 시작부터 지난 시간
  PRIMARY KEY (match_id, seq)
);

-- 대국 중에 연결이 끊긴 한 번. 유예 시간(15초) 안에 돌아왔으면 back_ms가 있고, 못 돌아오면 그 대국은 left로 끝납니다.
-- 이 기능 전의 대국에는 없습니다
CREATE TABLE match_drops (
  match_id TEXT NOT NULL,
  n        INTEGER NOT NULL,              -- 그 대국에서 몇 번째 끊김인지 (0부터)
  seat     INTEGER NOT NULL,              -- 끊긴 자리
  at_ms    INTEGER NOT NULL,              -- 끊긴 때 (대국 시작부터)
  back_ms  INTEGER,                       -- 돌아온 때. NULL이면 돌아오지 못했거나 그사이 대국이 끝남
  PRIMARY KEY (match_id, n)
);

-- AI 대국 하나 (브라우저가 두는 동안 보낸 기보). 사람이 첫 수를 둔 판부터 있습니다. 이 기능 전의 AI 대국은 ai_plays의 수만 있습니다.
-- 브라우저가 보고한 것이라 사람끼리의 대국(matches)과 따로 둡니다
CREATE TABLE ai_matches (
  id           TEXT PRIMARY KEY,
  game_id      TEXT NOT NULL,
  version      TEXT,                      -- 게임 코드 버전
  model        TEXT,                      -- 신경망 파일 (<해시>.onnx). 모델을 바꾸면 달라집니다
  level        TEXT NOT NULL,             -- easy, normal, hard
  sims         INTEGER NOT NULL,          -- AI가 한 행동마다 탐색한 횟수
  human_seat   INTEGER NOT NULL,          -- 사람이 앉은 자리 (0 선공, 1 후공)
  player_id    TEXT NOT NULL,             -- 사람. 탈퇴했으면 gone-0, gone-1
  player_kind  TEXT NOT NULL,             -- member, guest, gone
  player_name  TEXT,
  country      TEXT,                      -- 처음 보낸 때 접속한 나라. 모르면 NULL
  started_at   TEXT,
  ended_at     TEXT,                      -- 끝나지 않았으면 NULL
  updated_at   TEXT NOT NULL,             -- 마지막으로 받은 때
  day          TEXT NOT NULL,             -- 끝난 날 (끝나지 않았으면 마지막으로 받은 날)
  duration_sec REAL,                      -- 시작부터 끝(끝나지 않았으면 마지막으로 받은 때)까지
  actions      INTEGER NOT NULL,          -- 행동 수 (게임이 무시한 클릭 포함)
  status       TEXT NOT NULL,             -- ended(끝까지 둠), left(끝나기 전에 나감: 화면을 닫음, 다른 판으로 넘어감), playing(내보낸 때 두는 중)
  reason       TEXT,                      -- 끝난 이유: result(규칙대로), resign(사람이 기권), stuck(AI가 둘 수를 못 찾음). 안 끝났으면 NULL
  winner       INTEGER,                   -- 이긴 자리. NULL이면 무승부거나 안 끝남
  human_result TEXT                       -- 사람 쪽 결과: win, lose, draw. 안 끝났으면 NULL
);
CREATE INDEX ai_matches_game ON ai_matches (game_id);
CREATE INDEX ai_matches_player ON ai_matches (player_id);

-- AI 대국의 행동 하나하나 (match_actions와 같은 모양)
CREATE TABLE ai_match_actions (
  match_id TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  seat     INTEGER NOT NULL,
  kind     TEXT NOT NULL,
  row      INTEGER NOT NULL,
  col      INTEGER NOT NULL,
  at_ms    INTEGER NOT NULL,
  PRIMARY KEY (match_id, seq)
);

-- 게임마다 남긴 의견
CREATE TABLE comments (
  game_id     TEXT NOT NULL,
  id          TEXT NOT NULL,
  author_id   TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  day         TEXT NOT NULL,
  text        TEXT,                       -- 쓴 사람이 지운 의견은 NULL
  deleted     INTEGER NOT NULL,
  reporters   INTEGER NOT NULL,           -- 신고한 사람 수
  hidden      INTEGER NOT NULL,           -- 신고나 운영자 결정으로 가려졌는지
  PRIMARY KEY (game_id, id)
);

-- 즐겨찾기(별)
CREATE TABLE stars (
  game_id    TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY (game_id, account_id)
);

-- 날마다 온 사람 (GET /api/me를 부른 사람). 서버가 최근 30일만 남기므로 그 기간만 있습니다.
-- visitor는 서버만 아는 키로 만든 해시라 누구인지는 알 수 없고, 같은 사람은 날이 달라도 같은 값입니다.
-- 게스트가 쿠키를 지우거나 다른 브라우저로 오면 다른 사람으로 보입니다
CREATE TABLE visits (
  day     TEXT NOT NULL,
  visitor TEXT NOT NULL,
  member  INTEGER NOT NULL,               -- 그날 계정으로 왔는지
  country TEXT,                           -- 그날 처음 왔을 때의 나라 (KR, US, …). 모르면 NULL
  PRIMARY KEY (day, visitor)
);

-- 끝난 날의 방문 수. 서버가 방문을 세기 시작한 날부터 지우지 않고 남깁니다 (오늘은 없습니다)
CREATE TABLE daily_visits (
  day         TEXT PRIMARY KEY,
  visitors    INTEGER NOT NULL,           -- DAU (계정 + 게스트)
  members     INTEGER NOT NULL,           -- 그중 계정
  mau         INTEGER NOT NULL,           -- 그날까지 30일 동안 온 사람
  mau_members INTEGER NOT NULL
);

-- 끝난 날의 나라별 방문 수. 나라를 세기 시작한 날부터 있습니다. 나라를 모르는 사람은 빠집니다
CREATE TABLE daily_countries (
  day      TEXT NOT NULL,
  country  TEXT NOT NULL,                 -- KR, US, …
  visitors INTEGER NOT NULL,
  PRIMARY KEY (day, country)
);

-- 날마다, 게임마다 AI 대국 수 (운영 통계). 기보는 ai_matches에 있습니다 (그 기능을 넣은 뒤부터)
CREATE TABLE ai_plays (
  day     TEXT NOT NULL,
  game_id TEXT NOT NULL,
  plays   INTEGER NOT NULL,               -- 사람이 한 수 이상 둔 판
  ends    INTEGER NOT NULL,               -- 그중 끝까지 둔 판 (기권 포함)
  wins    INTEGER NOT NULL,               -- 끝난 판 중 사람이 이긴 판
  draws   INTEGER NOT NULL,               -- 끝난 판 중 비긴 판 (나머지는 AI가 이김)
  PRIMARY KEY (day, game_id)
);
