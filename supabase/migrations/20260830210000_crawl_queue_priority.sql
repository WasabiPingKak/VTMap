-- 佇列優先權:數字越大越先被認領(新註冊頻道插隊用)
alter table crawl_queue add column priority int not null default 0;

drop index idx_crawl_queue_claim;
create index idx_crawl_queue_claim on crawl_queue (status, kind, priority desc, id);
