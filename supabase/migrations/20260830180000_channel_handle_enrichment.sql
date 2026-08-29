-- 頻道正式名稱與 handle 分離:
--   title = 正式頻道名稱(YouTube channels.list 或 VTMap API)
--   handle = @開頭的帳號代稱(聊天室發言者名稱或 customUrl)
alter table channels add column handle text;
alter table channels add column enriched_at timestamptz;

-- 既有資料:聊天室來的 @開頭 title 其實是 handle
update channels set handle = title, title = null where title like '@%';
