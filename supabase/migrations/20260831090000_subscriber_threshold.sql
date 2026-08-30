-- 頻道訂閱數(enrich-channels 從 YouTube API statistics 取得;隱藏訂閱數者為 null)
alter table channels add column subscriber_count bigint;

-- 邊的准入加上訂閱數門檻:任一端已知訂閱數 < 100 即隱藏該關係
-- (訂閱數未知 = 尚未補完或頻道隱藏訂閱數,先放行避免圖被清空)
create or replace view network_edges as
select
  least(o.author_channel_id, o.host_channel_id) as channel_a,
  greatest(o.author_channel_id, o.host_channel_id) as channel_b,
  count(distinct o.video_id) as evidence_count,
  max(o.video_published_at) as last_seen_video_at,
  min(o.crawled_at) as first_observed_at
from chat_badge_observations o
join channels author_ch on author_ch.channel_id = o.author_channel_id
join channels host_ch on host_ch.channel_id = o.host_channel_id
where o.badge_type = 'moderator'
  and o.author_channel_id <> o.host_channel_id
  and coalesce(author_ch.has_stream_history, false)
  and not author_ch.is_bot
  and (author_ch.subscriber_count is null or author_ch.subscriber_count >= 100)
  and (host_ch.subscriber_count is null or host_ch.subscriber_count >= 100)
group by 1, 2;
