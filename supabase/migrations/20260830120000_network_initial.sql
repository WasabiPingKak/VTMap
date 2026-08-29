-- VTuber 關係網路:初始 schema
-- 設計原則:原始觀察(chat_badge_observations)與邊(network_edges view)分離,
-- 收緊或放寬准入規則時只需改 view,不需重爬。

-- 共用:updated_at 自動更新
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- 節點超集:所有被發現過的頻道(含尚未確認是否有直播紀錄的)
create table channels (
  channel_id text primary key,
  title text,
  thumbnail_url text,
  -- seed = 來自 VTMap 收錄清單;discovered = 從聊天室觀察到
  source text not null default 'discovered' check (source in ('seed', 'discovered')),
  in_vtmap boolean not null default false,
  is_bot boolean not null default false,
  -- 准入規則「曾經有直播紀錄」的檢查結果;null = 尚未檢查
  has_stream_history boolean,
  qualification_checked_at timestamptz,
  -- 距種子集合幾跳(種子 = 0)
  crawl_depth int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger channels_set_updated_at
  before update on channels
  for each row execute function set_updated_at();

-- 原始觀察事實:author 在 host 的影片聊天室中帶有某種 badge
create table chat_badge_observations (
  id bigint generated always as identity primary key,
  video_id text not null,
  host_channel_id text not null references channels (channel_id),
  author_channel_id text not null references channels (channel_id),
  badge_type text not null check (badge_type in ('moderator', 'owner', 'member')),
  message_count int not null default 0,
  video_published_at timestamptz,
  crawled_at timestamptz not null default now(),
  unique (video_id, author_channel_id, badge_type)
);

create index idx_observations_author on chat_badge_observations (author_channel_id);
create index idx_observations_host on chat_badge_observations (host_channel_id);

-- 爬蟲任務佇列
create table crawl_queue (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('list_videos', 'fetch_chat', 'check_qualification')),
  channel_id text,
  video_id text,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'done', 'failed')),
  attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 同一任務不重複排入(done 也算,重跑策略之後再另外處理)
create unique index idx_crawl_queue_dedupe
  on crawl_queue (kind, coalesce(channel_id, ''), coalesce(video_id, ''));
create index idx_crawl_queue_claim on crawl_queue (status, kind, id);

create trigger crawl_queue_set_updated_at
  before update on crawl_queue
  for each row execute function set_updated_at();

-- 每部影片的爬取結果紀錄(除錯與重跑判斷用)
create table crawl_log (
  id bigint generated always as identity primary key,
  video_id text not null,
  host_channel_id text,
  status text not null check (status in ('ok', 'no_chat', 'error')),
  message_lines int,
  distinct_authors int,
  moderator_count int,
  error text,
  crawled_at timestamptz not null default now()
);

create index idx_crawl_log_video on crawl_log (video_id);

-- 邊(推導物):管理員關係,正規化為無向(channel_a < channel_b)
-- 准入條件:author 通過「曾經有直播紀錄」且非 bot;host 必然有直播紀錄(觀察即來自其 VOD)
create view network_edges as
select
  least(o.author_channel_id, o.host_channel_id) as channel_a,
  greatest(o.author_channel_id, o.host_channel_id) as channel_b,
  count(distinct o.video_id) as evidence_count,
  max(o.video_published_at) as last_seen_video_at,
  min(o.crawled_at) as first_observed_at
from chat_badge_observations o
join channels author_ch on author_ch.channel_id = o.author_channel_id
where o.badge_type = 'moderator'
  and o.author_channel_id <> o.host_channel_id
  and coalesce(author_ch.has_stream_history, false)
  and not author_ch.is_bot
group by 1, 2;
