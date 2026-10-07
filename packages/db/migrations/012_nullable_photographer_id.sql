-- Public photos have an uploader but no official photographer.
update photos set photographer_id = null where collection = 'public';
update upload_sessions set photographer_id = null where collection = 'public';
alter table photos alter column photographer_id drop not null;
alter table upload_sessions alter column photographer_id drop not null;
