-- 受限影片的爬取結果:members_only / age_restricted / video_unavailable
-- 這類影片不是錯誤也不需重試,獨立成 status 以便和真正的失敗區分
alter table crawl_log drop constraint crawl_log_status_check;
alter table crawl_log add constraint crawl_log_status_check
  check (status in ('ok', 'no_chat', 'error',
                    'members_only', 'age_restricted', 'video_unavailable'));
