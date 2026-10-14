-- LOCAL ONLY. Runs first of the seed files (config.toml reads ./seeds/*.sql in order).
--
-- The seeds in this folder create test helpers and, in later tasks, test data. They must never reach a hosted project
-- (spec H5: dev may hold test data, prod holds only D20). `supabase db reset --linked` or `db push --include-seed`
-- would run them there, so this file refuses to continue unless the database's JWT secret is the default that the
-- Supabase CLI gives every local stack (`supabase status` prints it as JWT_SECRET). A hosted project has its own secret,
-- or none readable here, and the check fails closed: anything that is not exactly the local default stops the whole seed run.
--
-- Only the SHA-256 digest of that default is written below, so no secret-looking text sits in the repository. To check
-- it on a local stack: select encode(sha256(convert_to(current_setting('app.settings.jwt_secret'), 'utf8')), 'hex');
do $guard$
declare
  v_secret text := current_setting('app.settings.jwt_secret', true);
begin
  if v_secret is null
     or encode(sha256(convert_to(v_secret, 'utf8')), 'hex')
        is distinct from 'a064b502e61d27e94b8717290e5e1b32e36720e9fbdf952ec81a84c07128cb37' then
    raise exception 'seed guard: refusing to run the seeds on a database whose JWT secret is not the local default'
      using hint = 'These seeds are for the local Supabase stack only (npm run db:reset). Never run them on a hosted project. On a local stack after a CLI upgrade, the digest here no longer matches the CLI default.';
  end if;
end
$guard$;
