SET LOCAL search_path TO rastreia,public;

-- Only hashes of browser leases and AWS resource identifiers; never stream keys or playback JWTs.
CREATE TABLE commerce_live_video (
 live_id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL,
 channel_arn text NOT NULL, ingest_endpoint text, playback_url text,
 owner_id uuid NOT NULL REFERENCES users(id), lease_hash text NOT NULL CHECK(lease_hash ~ '^[a-f0-9]{64}$'),
 lease_until timestamptz NOT NULL, state text NOT NULL DEFAULT 'PREPARING' CHECK(state IN ('PREPARING','READY','STOPPED')),
 shutdown_requested boolean NOT NULL DEFAULT false, provider_online boolean NOT NULL DEFAULT false,
 checked_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(live_id,tenant_id,store_id) REFERENCES commerce_live_sessions(id,tenant_id,store_id)
);
CREATE UNIQUE INDEX commerce_video_channel_active ON commerce_live_video(channel_arn) WHERE state<>'STOPPED';
ALTER TABLE commerce_live_video ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_live_video FORCE ROW LEVEL SECURITY;
CREATE POLICY commerce_video_manager ON commerce_live_video USING(tenant_id=current_tenant_id() AND commerce_manage_store(store_id))
 WITH CHECK(tenant_id=current_tenant_id() AND commerce_manage_store(store_id));
GRANT SELECT,INSERT,UPDATE ON commerce_live_video TO rastreia_runtime;

CREATE TABLE commerce_live_video_worker (id boolean PRIMARY KEY DEFAULT true CHECK(id), seen_at timestamptz NOT NULL);
GRANT SELECT ON commerce_live_video_worker TO rastreia_runtime;

CREATE TABLE commerce_live_viewers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), live_id uuid NOT NULL REFERENCES commerce_live_video(live_id),
 lease_hash text NOT NULL CHECK(lease_hash ~ '^[a-f0-9]{64}$'), lease_until timestamptz NOT NULL,
 revoked_at timestamptz, release_after timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(live_id,lease_hash)
);
CREATE INDEX commerce_live_viewers_active ON commerce_live_viewers(live_id,lease_until) WHERE release_after IS NULL;
ALTER TABLE commerce_live_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_live_viewers FORCE ROW LEVEL SECURITY;
-- No direct runtime privileges. Anonymous admission is restricted to the public token through this function.
CREATE FUNCTION commerce_live_viewer(requested_token text, requested_hash text, renew_only boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
DECLARE session commerce_live_sessions; video commerce_live_video; viewer commerce_live_viewers; capacity integer;
BEGIN
 IF requested_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO session FROM commerce_live_sessions WHERE public_token=requested_token;
 IF session.id IS NULL OR (commerce_public_live(requested_token)->>'status') IS DISTINCT FROM 'LIVE' THEN RETURN NULL; END IF;
 SELECT * INTO video FROM commerce_live_video WHERE live_id=session.id FOR UPDATE;
 IF video.state IS DISTINCT FROM 'READY' OR video.shutdown_requested OR video.lease_until<=now()
 OR NOT video.provider_online OR video.checked_at<now()-interval '45 seconds'
 OR NOT EXISTS(SELECT 1 FROM commerce_live_video_worker WHERE seen_at>now()-interval '60 seconds') THEN RETURN NULL; END IF;
 SELECT * INTO viewer FROM commerce_live_viewers WHERE live_id=session.id AND lease_hash=requested_hash;
 IF viewer.id IS NOT NULL THEN
   IF viewer.lease_until<=now() OR viewer.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('error','VIEWER_EXPIRED'); END IF;
   IF NOT renew_only THEN RETURN jsonb_build_object('error','VIEWER_ALREADY_ISSUED'); END IF;
 ELSE
   IF renew_only THEN RETURN NULL; END IF;
   SELECT p.max_concurrent_viewers INTO capacity FROM store_live_subscriptions s JOIN live_plan_versions p ON p.id=s.plan_version_id WHERE s.id=session.subscription_id;
   IF (SELECT count(*) FROM commerce_live_viewers WHERE live_id=session.id AND (release_after IS NULL OR release_after>now()))>=capacity THEN
     RETURN jsonb_build_object('error','LIVE_AUDIENCE_FULL');
   END IF;
   INSERT INTO commerce_live_viewers(live_id,lease_hash,lease_until) VALUES(session.id,requested_hash,LEAST(session.deadline_at,now()+interval '90 seconds')) RETURNING * INTO viewer;
 END IF;
 UPDATE commerce_live_viewers SET lease_until=LEAST(session.deadline_at,now()+interval '90 seconds') WHERE id=viewer.id;
 RETURN jsonb_build_object('id',viewer.id,'channelArn',video.channel_arn,'playbackUrl',video.playback_url,'deadlineAt',session.deadline_at);
END $$;
REVOKE ALL ON FUNCTION commerce_live_viewer(text,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_live_viewer(text,text,boolean) TO rastreia_runtime;

CREATE FUNCTION commerce_live_viewer_leave(requested_token text,requested_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=rastreia,public,pg_temp AS $$
 UPDATE commerce_live_viewers SET lease_until=LEAST(lease_until,now())
 WHERE lease_hash=requested_hash AND live_id=(SELECT id FROM commerce_live_sessions WHERE public_token=requested_token)
$$;
REVOKE ALL ON FUNCTION commerce_live_viewer_leave(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION commerce_live_viewer_leave(text,text) TO rastreia_runtime;
