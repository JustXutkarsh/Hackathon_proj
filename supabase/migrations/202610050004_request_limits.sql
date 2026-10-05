begin;
create table countmein_private.request_limits (
  bucket text primary key check(length(bucket) between 1 and 160),
  started_at timestamptz not null, requests integer not null check(requests>0)
);
alter table countmein_private.request_limits enable row level security;
create policy deny_direct_access on countmein_private.request_limits as restrictive for all using(false) with check(false);
revoke all on countmein_private.request_limits from public,anon,authenticated;
create function public.release_request_limit(p_bucket text,p_max integer) returns boolean
language plpgsql security definer set search_path='' as $$
declare used integer;
begin
  if p_max not between 1 and 120 then raise exception 'Invalid request limit.'; end if;
  delete from countmein_private.request_limits where started_at < clock_timestamp()-interval '10 minutes';
  insert into countmein_private.request_limits as limits values(p_bucket,clock_timestamp(),1)
    on conflict(bucket) do update set
      requests=case when limits.started_at <= clock_timestamp()-interval '1 minute' then 1 else limits.requests+1 end,
      started_at=case when limits.started_at <= clock_timestamp()-interval '1 minute' then clock_timestamp() else limits.started_at end
    returning requests into used;
  return used<=p_max;
end;
$$;
revoke all on function public.release_request_limit(text,integer) from public,anon,authenticated;
grant execute on function public.release_request_limit(text,integer) to service_role;
commit;
