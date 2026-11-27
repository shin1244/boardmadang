-- 보드마당 분석 쿼리 모음. 먼저 analysis/README.md를 보고 boardmadang.db를 만듭니다.
-- 한 번에 하나씩 골라 실행합니다 (DB Browser for SQLite의 "SQL 실행" 탭, 또는 sqlite3).
-- 표와 칸의 뜻은 server/cmd/dbexport/schema.sql에 있습니다.
--
-- 사람이 적을 때는 비율보다 사람 수를 보세요. 10명 중 1명이 10%p입니다.


-- 1. 날마다 방문자 (DAU)와 MAU ------------------------------------------------
-- daily_visits는 서버가 방문을 세기 시작한 날부터 끝난 날까지 있습니다.
SELECT day, visitors AS dau, members AS dau_members, mau
FROM daily_visits
ORDER BY day DESC
LIMIT 30;

-- 1-1. 최근 30일 (오늘 포함). 서버가 30일만 남기는 visits로 셉니다
SELECT day, count(*) AS dau, sum(member) AS members, count(*) - sum(member) AS guests
FROM visits
GROUP BY day
ORDER BY day DESC;


-- 2. 날마다 대국 수와 대국을 둔 사람 수 ----------------------------------------
-- counted = 1: 무효, 행동 없음, 혼자 두 자리에 앉은 대국을 뺍니다 (로비 인기순과 같은 기준)
SELECT m.day,
       count(DISTINCT m.id) AS matches,
       count(DISTINCT p.player_id) AS players
FROM matches m
JOIN match_players p ON p.match_id = m.id
WHERE m.counted = 1
GROUP BY m.day
ORDER BY m.day DESC
LIMIT 30;


-- 3. 게임별 인기: 판 수, 둔 사람, 별, 의견, AI 대국 ----------------------------
SELECT g.id,
       coalesce(g.name_ko, g.id) AS name,
       g.source,
       (SELECT count(*) FROM matches m WHERE m.game_id = g.id AND m.counted = 1) AS matches,
       (SELECT count(DISTINCT p.player_id) FROM matches m JOIN match_players p ON p.match_id = m.id
         WHERE m.game_id = g.id AND m.counted = 1) AS players,
       (SELECT count(*) FROM stars s WHERE s.game_id = g.id) AS stars,
       (SELECT count(*) FROM comments c WHERE c.game_id = g.id AND c.deleted = 0) AS comments,
       (SELECT total(a.plays) FROM ai_plays a WHERE a.game_id = g.id) AS ai_plays
FROM games g
ORDER BY matches DESC, ai_plays DESC;


-- 4. 게임별 끝난 이유 -----------------------------------------------------------
-- 규칙대로 끝난 판(result)이 적고 나감(left), 기권(resign), 시간패(timeout)가 많으면
-- 지루하거나 너무 긴 게임, 또는 처음 온 사람이 규칙을 몰라 떠나는 게임일 수 있습니다.
SELECT game_id, reason, count(*) AS n,
       round(100.0 * count(*) / sum(count(*)) OVER (PARTITION BY game_id), 1) AS pct
FROM matches
WHERE counted = 1
GROUP BY game_id, reason
ORDER BY game_id, n DESC;


-- 5. 선공 승률 (밸런스) ---------------------------------------------------------
-- 선후공은 대국마다 무작위입니다. 50%에서 크게 벗어나면 한쪽이 유리한 게임입니다.
-- 판이 적으면 우연으로도 크게 흔들립니다 (30판쯤부터 봅니다).
-- 규칙대로 끝난 판만 보려면 WHERE에 AND reason = 'result'를 더합니다.
SELECT game_id,
       count(*) AS matches,
       round(100.0 * total(winner = 0) / count(*), 1) AS first_win_pct,
       round(100.0 * total(winner = 1) / count(*), 1) AS second_win_pct,
       round(100.0 * total(winner IS NULL) / count(*), 1) AS draw_pct
FROM matches
WHERE counted = 1
GROUP BY game_id
ORDER BY matches DESC;


-- 6. 대국 길이: 시간과 행동 수 --------------------------------------------------
-- 행동 수에는 게임이 무시한 클릭(기물 고르기 등)도 들어 있습니다.
SELECT game_id,
       count(*) AS matches,
       round(avg(duration_sec) / 60, 1) AS avg_min,
       round(min(duration_sec) / 60, 1) AS min_min,
       round(max(duration_sec) / 60, 1) AS max_min,
       round(avg(actions), 1) AS avg_actions
FROM matches
WHERE counted = 1
GROUP BY game_id
ORDER BY matches DESC;


-- 7. 첫 수는 어디에 두나 (게임 하나를 골라 game_id를 바꿉니다) -----------------
SELECT a.row, a.col, a.kind, count(*) AS n
FROM match_actions a
JOIN matches m ON m.id = a.match_id
WHERE m.game_id = 'tictactoe' AND m.counted = 1 AND a.seq = 0
GROUP BY a.row, a.col, a.kind
ORDER BY n DESC;


-- 8. 사람별 활동 ----------------------------------------------------------------
-- 사람이 적을 때 가장 쓸모 있는 표입니다. 한 번 두고 안 온 사람, 자주 오는 사람이 한눈에 보입니다.
-- 게스트(g_)는 쿠키를 지우거나 다른 브라우저로 오면 다른 사람이 되고, 계정을 만들면 m_로 새로 시작합니다.
SELECT p.player_id,
       p.kind,
       coalesce(acc.name, max(p.name)) AS name,
       min(m.day) AS first_day,
       max(m.day) AS last_day,
       count(*) AS matches,
       count(DISTINCT m.day) AS active_days,
       count(DISTINCT m.game_id) AS games
FROM match_players p
JOIN matches m ON m.id = p.match_id AND m.counted = 1
LEFT JOIN accounts acc ON acc.id = p.player_id
WHERE p.kind <> 'gone'
GROUP BY p.player_id
ORDER BY last_day DESC, matches DESC;


-- 9. 대국 리텐션 (코호트) -------------------------------------------------------
-- 처음 대국을 둔 날로 사람을 묶고, 다음 날(d1), 7일 뒤(d7), 그 뒤 언제라도(came_back) 다시 둔 사람을 셉니다.
-- 기보는 지우지 않으므로 30일보다 긴 리텐션도 볼 수 있습니다. 7일이 안 지난 묶음의 d7은 아직 0입니다.
WITH active AS (
  SELECT DISTINCT p.player_id, m.day
  FROM match_players p
  JOIN matches m ON m.id = p.match_id
  WHERE m.counted = 1 AND p.kind <> 'gone'
),
cohort AS (
  SELECT player_id, min(day) AS first_day FROM active GROUP BY player_id
)
SELECT c.first_day,
       count(*) AS new_players,
       sum(EXISTS (SELECT 1 FROM active a WHERE a.player_id = c.player_id AND a.day = date(c.first_day, '+1 day'))) AS d1,
       sum(EXISTS (SELECT 1 FROM active a WHERE a.player_id = c.player_id AND a.day = date(c.first_day, '+7 day'))) AS d7,
       sum(EXISTS (SELECT 1 FROM active a WHERE a.player_id = c.player_id AND a.day > c.first_day)) AS came_back
FROM cohort c
GROUP BY c.first_day
ORDER BY c.first_day DESC;


-- 10. 방문 리텐션 (최근 30일 안에서만, 대강) ------------------------------------
-- visits는 30일만 있어서 "처음 온 날"이 정확하지 않습니다 (그 전에 왔던 사람도 처음처럼 보임).
-- 그래서 가장 오래된 날은 뺍니다.
WITH cohort AS (
  SELECT visitor, min(day) AS first_day FROM visits GROUP BY visitor
)
SELECT c.first_day,
       count(*) AS new_visitors,
       sum(EXISTS (SELECT 1 FROM visits v WHERE v.visitor = c.visitor AND v.day = date(c.first_day, '+1 day'))) AS d1,
       sum(EXISTS (SELECT 1 FROM visits v WHERE v.visitor = c.visitor AND v.day = date(c.first_day, '+7 day'))) AS d7,
       sum(EXISTS (SELECT 1 FROM visits v WHERE v.visitor = c.visitor AND v.day > c.first_day)) AS came_back
FROM cohort c
WHERE c.first_day > (SELECT min(day) FROM visits)
GROUP BY c.first_day
ORDER BY c.first_day DESC;


-- 11. 가입한 날별 계정 수와, 그중 대국을 둔 사람 --------------------------------
SELECT a.created_day,
       count(*) AS signups,
       sum(EXISTS (SELECT 1 FROM match_players p JOIN matches m ON m.id = p.match_id
                   WHERE p.player_id = a.id AND m.counted = 1)) AS played
FROM accounts a
GROUP BY a.created_day
ORDER BY a.created_day DESC;


-- 12. AI 대국: 끝까지 둔 비율과 사람 승률 ---------------------------------------
-- 사람 승률이 아주 낮으면 AI가 너무 세고, 끝까지 둔 비율이 낮으면 중간에 그만두는 판이 많은 것입니다.
SELECT game_id,
       sum(plays) AS plays,
       sum(ends) AS ends,
       round(100.0 * sum(ends) / sum(plays), 1) AS finish_pct,
       round(100.0 * sum(wins) / nullif(sum(ends), 0), 1) AS human_win_pct,
       round(100.0 * sum(draws) / nullif(sum(ends), 0), 1) AS draw_pct
FROM ai_plays
GROUP BY game_id
ORDER BY plays DESC;


-- 13. 게임 업데이트 전후: 코드 버전별 판 수와 선공 승률 -------------------------
SELECT m.game_id, m.version, min(m.day) AS from_day, max(m.day) AS to_day,
       count(*) AS matches,
       round(100.0 * total(m.winner = 0) / count(*), 1) AS first_win_pct
FROM matches m
WHERE m.counted = 1
GROUP BY m.game_id, m.version
ORDER BY m.game_id, from_day;


-- 14. 몇 시에, 무슨 요일에 두나 -------------------------------------------------
SELECT strftime('%H', started_at) AS hour, count(*) AS matches
FROM matches
WHERE counted = 1
GROUP BY hour
ORDER BY hour;

-- 요일: 0 = 일요일, 6 = 토요일
SELECT strftime('%w', day) AS weekday, count(*) AS matches
FROM matches
WHERE counted = 1
GROUP BY weekday
ORDER BY weekday;


-- 15. 어디서 오나: 나라별 방문 ---------------------------------------------------
-- 하루에 한 번씩 센 방문을 나라별로 더합니다 (운영자 화면과 같은 기준). 나라를 세기 시작한 날부터 있습니다.
SELECT country, sum(visitors) AS visits, count(DISTINCT day) AS days
FROM daily_countries
GROUP BY country
ORDER BY visits DESC;

-- 15-1. 최근 30일, 나라별로 서로 다른 사람 수 (visits는 30일만 있습니다)
-- 날마다 다른 나라에서 온 사람(여행, VPN)은 두 나라에 다 들어갑니다.
SELECT coalesce(country, '알 수 없음') AS country, count(DISTINCT visitor) AS people, count(*) AS visits
FROM visits
GROUP BY country
ORDER BY people DESC;

-- 16. 이탈: AI 대국에서 끝나기 전에 나간 판 -----------------------------------------
-- 화면을 닫거나 다른 판으로 넘어간 판(status = left)이 몇 번째 행동에서 멈췄는지 게임마다 봅니다.
-- 초반에 많이 나가면 규칙이나 화면이 어려운 것일 수 있습니다.
SELECT game_id, count(*) AS left_games,
       sum(actions < 10) AS under_10, sum(actions BETWEEN 10 AND 29) AS from_10_to_29, sum(actions >= 30) AS from_30,
       round(avg(duration_sec)) AS avg_sec
FROM ai_matches
WHERE status = 'left'
GROUP BY game_id
ORDER BY left_games DESC;

-- 16-1. 게임마다 AI 대국을 끝까지 둔 비율 (내보낸 때 두는 중인 판은 뺍니다)
SELECT game_id, count(*) AS games, sum(status = 'ended') AS ended, sum(status = 'left') AS left_games,
       round(100.0 * sum(status = 'left') / count(*), 1) AS left_pct
FROM ai_matches
WHERE status <> 'playing'
GROUP BY game_id
ORDER BY games DESC;

-- 17. 온라인 대국에서 연결이 끊긴 뒤 돌아왔나 --------------------------------------
-- 돌아오지 못한 끊김은 그 대국이 left(나감)로 끝난 것입니다.
SELECT m.game_id, count(*) AS drops, sum(d.back_ms IS NOT NULL) AS came_back,
       round(avg((d.back_ms - d.at_ms) / 1000.0), 1) AS avg_away_sec
FROM match_drops d
JOIN matches m ON m.id = d.match_id
GROUP BY m.game_id
ORDER BY drops DESC;

-- 18. 나라별로 대국을 둔 사람 ------------------------------------------------------
-- 대국을 시작할 때 접속한 나라입니다 (그 기능을 넣은 뒤의 대국만).
SELECT coalesce(p.country, '알 수 없음') AS country, count(DISTINCT p.player_id) AS people, count(*) AS seats
FROM match_players p
JOIN matches m ON m.id = p.match_id
WHERE m.counted = 1
GROUP BY country
ORDER BY people DESC;

-- 19. 한 행동에 걸린 시간: 앞 행동과의 차이 -----------------------------------------
-- 첫 행동은 대국 시작부터 잰 시간입니다. SQLite에는 중앙값이 없어 평균과 최대를 봅니다.
WITH gaps AS (
  SELECT match_id, seat, at_ms - lag(at_ms, 1, 0) OVER (PARTITION BY match_id ORDER BY seq) AS ms
  FROM match_actions
)
SELECT m.game_id, count(*) AS actions, round(avg(g.ms) / 1000.0, 1) AS avg_sec, round(max(g.ms) / 1000.0) AS max_sec
FROM gaps g
JOIN matches m ON m.id = g.match_id
WHERE m.counted = 1
GROUP BY m.game_id
ORDER BY actions DESC;
