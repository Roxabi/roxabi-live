# Changelog

## [0.13.1](https://github.com/Roxabi/roxabi-live/compare/roxabi-live/v0.13.0...roxabi-live/v0.13.1) (2026-06-19)


### Features

* **zk:** lost-passphrase recovery — reset server ciphertext and re-enroll ([#220](https://github.com/Roxabi/roxabi-live/pull/220))


### Bug Fixes

* **zk:** consume reauth proof before purge on `POST /api/zk/reset` ([#221](https://github.com/Roxabi/roxabi-live/pull/221))


### Chores

* **zk:** nuclear D1 reset + enable `ZK_ACCOUNT_KEY` in production ([#219](https://github.com/Roxabi/roxabi-live/pull/219))

## [0.13.0](https://github.com/Roxabi/roxabi-live/compare/roxabi-live/v0.12.0...roxabi-live/v0.13.0) (2026-06-18)


### Features

* **zk:** account-key multi-device encryption — passphrase backup, enroll/unlock UI, structure-only sync ([#216](https://github.com/Roxabi/roxabi-live/issues/216), [#217](https://github.com/Roxabi/roxabi-live/pull/217))
* **zk:** private mode always on, redact graph titles by sealed keys ([#216](https://github.com/Roxabi/roxabi-live/issues/216))
* **security:** ZK mode opt-in preference — API + UI ([#142](https://github.com/Roxabi/roxabi-live/issues/142) S1, [#202](https://github.com/Roxabi/roxabi-live/pull/202))
* **security:** ZK ciphertext pipeline — seal titles client-side ([#142](https://github.com/Roxabi/roxabi-live/issues/142) S2, [#207](https://github.com/Roxabi/roxabi-live/pull/207))
* **security:** ZK user token handoff + GitHub body sync ([#142](https://github.com/Roxabi/roxabi-live/issues/142) S3, [#209](https://github.com/Roxabi/roxabi-live/pull/209))
* **worker:** scrub D1 plaintext titles for zk-sealed issues ([#142](https://github.com/Roxabi/roxabi-live/issues/142), [#211](https://github.com/Roxabi/roxabi-live/pull/211))
* **graph:** server param for closed-under-open-epic filter ([#214](https://github.com/Roxabi/roxabi-live/pull/214))
* **graph:** default ready/blocked server filter and flat grouping


### Bug Fixes

* **zk:** address PR [#217](https://github.com/Roxabi/roxabi-live/pull/217) review blockers (flag gate, reauth, CAS, migration safety)
* **ci:** Node 22 for worker/deploy (wrangler 4) ([#205](https://github.com/Roxabi/roxabi-live/pull/205))


### Documentation

* **zk:** approved account-key design spec + `ZK_ENCRYPTION.md` ([#216](https://github.com/Roxabi/roxabi-live/issues/216))


### Chores

* **ci:** repoint file_length gate to worker TS ([#180](https://github.com/Roxabi/roxabi-live/issues/180), [#199](https://github.com/Roxabi/roxabi-live/pull/199))
* **deps:** upgrade vitest 3.2.6 + wrangler 4.101.0 ([#156](https://github.com/Roxabi/roxabi-live/issues/156), [#200](https://github.com/Roxabi/roxabi-live/pull/200))
* **test:** extract FakeD1 harness to `worker/test/fake-d1.ts` ([#159](https://github.com/Roxabi/roxabi-live/issues/159), [#201](https://github.com/Roxabi/roxabi-live/pull/201))

## [0.12.0](https://github.com/Roxabi/roxabi-live/compare/roxabi-live/v0.11.0...roxabi-live/v0.12.0) (2026-06-17)


### Features

* **webhook:** handle repository.created to register new repos ([fd5e6d3](https://github.com/Roxabi/roxabi-live/commit/fd5e6d3f0b9c123283a4d0c1cd3092d72f19b390))
* **webhook:** real-time repo.created discovery + restore archived flag ([#160](https://github.com/Roxabi/roxabi-live/issues/160) fallout) ([9b6a24e](https://github.com/Roxabi/roxabi-live/commit/9b6a24e1684eb1bfb596e678b5433eb36e2f4ac6))


### Bug Fixes

* **auth:** re-verify user_installations in validateSession ([#185](https://github.com/Roxabi/roxabi-live/issues/185)) ([6398eb9](https://github.com/Roxabi/roxabi-live/commit/6398eb9610f9c42d6c9c682af732cddb33f30e30))
* **auth:** re-verify user_installations in validateSession ([#185](https://github.com/Roxabi/roxabi-live/issues/185)) ([fccd515](https://github.com/Roxabi/roxabi-live/commit/fccd51563de0fec1abf52e91a00bee6146eefef0))
* **sync:** restore archived repo flag lost in [#160](https://github.com/Roxabi/roxabi-live/issues/160) cutover ([75fcfe0](https://github.com/Roxabi/roxabi-live/commit/75fcfe0ea5e7184d38275f7b757264416fa79a3a))

## [0.11.0](https://github.com/Roxabi/roxabi-live/compare/roxabi-live/v0.10.0...roxabi-live/v0.11.0) (2026-06-16)


### Features

* **api:** tenant-filtered reads + active-tenant + private-repo authz ([23c5de5](https://github.com/Roxabi/roxabi-live/commit/23c5de52213faa2ad556be08b28516392111ec0a))
* **auth:** tenant-filtered reads + active-tenant + private-repo authz ([#148](https://github.com/Roxabi/roxabi-live/issues/148)) ([b8469d5](https://github.com/Roxabi/roxabi-live/commit/b8469d541c8fcb592604b713c6c2b26f8624de79))
* **deploy:** NOT-NULL migration + CF Access cutover + runbook ([#150](https://github.com/Roxabi/roxabi-live/issues/150)) ([456ec60](https://github.com/Roxabi/roxabi-live/commit/456ec600ce8bf5125128193e935f08ae029fe843))
* **deploy:** NOT-NULL migration + CF Access cutover runbook ([#150](https://github.com/Roxabi/roxabi-live/issues/150)) ([ae23f09](https://github.com/Roxabi/roxabi-live/commit/ae23f09eae3ab737f1dfe9b508b384ce9e1f8519))
* **sync:** daily full reconcile + richer run audit, disable staging cron ([#80](https://github.com/Roxabi/roxabi-live/issues/80)) ([dac4c39](https://github.com/Roxabi/roxabi-live/commit/dac4c39d5ea24086d3fe3cd7513256edfaec51d9))
* **sync:** daily full reconcile + richer run audit, disable staging cron ([#80](https://github.com/Roxabi/roxabi-live/issues/80)) ([d10cba2](https://github.com/Roxabi/roxabi-live/commit/d10cba2d7a349e4dda23faf8af513bdc5e3c19d3))
* **ui:** login + account-link + operator-read consent gate ([5d3ee2d](https://github.com/Roxabi/roxabi-live/commit/5d3ee2d51e2dc9c18d97335f9b3e53e138d392e2))
* **ui:** login + account-link + operator-read consent gate ([#149](https://github.com/Roxabi/roxabi-live/issues/149)) ([4eec7bd](https://github.com/Roxabi/roxabi-live/commit/4eec7bdd2100bc2453a293a72e2addfe19769171))
* **webhook:** tenant routing gate + GitHub-App lifecycle handlers ([#147](https://github.com/Roxabi/roxabi-live/issues/147)) ([6c88174](https://github.com/Roxabi/roxabi-live/commit/6c88174efb6909dc500547a860997485c3716565))
* **webhook:** tenant routing gate + GitHub-App lifecycle handlers ([#147](https://github.com/Roxabi/roxabi-live/issues/147)) ([69849b1](https://github.com/Roxabi/roxabi-live/commit/69849b1680a0966ea137ed8ce8ea25d603e2e519))


### Bug Fixes

* **auth/test:** widen captureDb type + bounded base64url encode per PR [#182](https://github.com/Roxabi/roxabi-live/issues/182) review ([#163](https://github.com/Roxabi/roxabi-live/issues/163)) ([39d7a60](https://github.com/Roxabi/roxabi-live/commit/39d7a60ac6d31e4c922a532ab411b22e3433866b))
* **auth:** add D1 batch transaction note + narrow tenant id array once ([#158](https://github.com/Roxabi/roxabi-live/issues/158)) ([4944a74](https://github.com/Roxabi/roxabi-live/commit/4944a74de8606c12d69f60b6ccdccaabc71e4a75))
* **auth:** apply PR [#171](https://github.com/Roxabi/roxabi-live/issues/171) review — tenantId thread, suspended guard, drop installation_id ([#148](https://github.com/Roxabi/roxabi-live/issues/148)) ([0d59a8d](https://github.com/Roxabi/roxabi-live/commit/0d59a8d558414a1588a92c0012fe767c19220db3))
* **auth:** fail-closed guard for unknown tenant in getInstallationToken ([415c5b0](https://github.com/Roxabi/roxabi-live/commit/415c5b04100c2918cd2c532f8a054c98248d94a5))
* **auth:** guard getInstallationToken against suspended installs ([#166](https://github.com/Roxabi/roxabi-live/issues/166)) ([6108273](https://github.com/Roxabi/roxabi-live/commit/6108273c627a769711a0f7424d50b936b9da5a62))
* **deploy:** apply PR [#173](https://github.com/Roxabi/roxabi-live/issues/173) review findings ([#150](https://github.com/Roxabi/roxabi-live/issues/150)) ([8d7fabc](https://github.com/Roxabi/roxabi-live/commit/8d7fabc168919935094e9146f0a6c72d0469b6e7))
* promote staging → main — consent-gate overlay hotfix ([#176](https://github.com/Roxabi/roxabi-live/issues/176)) ([5b0b10a](https://github.com/Roxabi/roxabi-live/commit/5b0b10a11965e24da3a521e927d64b2fd32380ab))
* **sync:** 2 slots so daily cron full-reconciles each repo every 2 days ([#80](https://github.com/Roxabi/roxabi-live/issues/80)) ([7350397](https://github.com/Roxabi/roxabi-live/commit/73503978947301b4049de1f10f27b8ef6c40f4e3))
* **test:** non-tautological asserts + migration-count robustness per PR [#181](https://github.com/Roxabi/roxabi-live/issues/181) review ([#154](https://github.com/Roxabi/roxabi-live/issues/154)) ([8828d69](https://github.com/Roxabi/roxabi-live/commit/8828d6969f715b1377b7dd809bbca65e81917c84))
* **ui:** apply review findings — consent copy, gate UX, a11y, logout ([#149](https://github.com/Roxabi/roxabi-live/issues/149)) ([137e580](https://github.com/Roxabi/roxabi-live/commit/137e580a12b2a6f57bc134408ec3b11471847865))
* **ui:** consent-gate overlay always painted — hidden overridden by display:flex ([852250d](https://github.com/Roxabi/roxabi-live/commit/852250d01a8b6a0ee8c8f14ac2d4c871bfc1edb7))
* **ui:** consent-gate overlay always visible — hidden attr overridden by display:flex ([14fb090](https://github.com/Roxabi/roxabi-live/commit/14fb090f73d191d17afed4b026d0b69f1bbdbc4f))
* **webhook:** apply PR [#179](https://github.com/Roxabi/roxabi-live/issues/179) review findings ([#147](https://github.com/Roxabi/roxabi-live/issues/147)) ([fee7bed](https://github.com/Roxabi/roxabi-live/commit/fee7bed858c47ef87417624a7b6bc12cb534e7bb))


### Documentation

* **148:** plan + spec amendment (Option-3 self-absorb) ([f504486](https://github.com/Roxabi/roxabi-live/commit/f5044868b134e26479c38c52e33e467178c9715a))
* **plan:** [#147](https://github.com/Roxabi/roxabi-live/issues/147) webhook tenant routing + lifecycle handlers — plan + gap analysis ([2b49ccd](https://github.com/Roxabi/roxabi-live/commit/2b49ccde705e748fab428ba0708699b1a7df5159))
* **plan:** [#149](https://github.com/Roxabi/roxabi-live/issues/149) login + operator-read consent UI plan (F-lite) ([99a28ce](https://github.com/Roxabi/roxabi-live/commit/99a28ceb09041c1265c8f0f180b69ae213fd99b3))
* self-hosting deploy guide + CF-era doc refresh ([fd6e2bc](https://github.com/Roxabi/roxabi-live/commit/fd6e2bcd8c11e32fedaeba1d7efcacc5dd29e5f3))
* self-hosting deploy guide + CF-era doc refresh ([ae5a59f](https://github.com/Roxabi/roxabi-live/commit/ae5a59f7d9960760facfcf04db894c853a8b019d))

## [0.10.0](https://github.com/Roxabi/roxabi-live/compare/roxabi-live/v0.9.0...roxabi-live/v0.10.0) (2026-06-13)


### Features

* **#43:** corpus live access — reconciler + webhook + issues API + tunnel ([#55](https://github.com/Roxabi/roxabi-live/issues/55)) ([26fa3ad](https://github.com/Roxabi/roxabi-live/commit/26fa3ada7936a233174009cfa6fa8bb5cbc254e7))
* **api:** [#56](https://github.com/Roxabi/roxabi-live/issues/56) harden public API surface ([#62](https://github.com/Roxabi/roxabi-live/issues/62)) ([e74d811](https://github.com/Roxabi/roxabi-live/commit/e74d8115ac731ad425e84ca7142f3bfa281b6a6e))
* **app:** add FastAPI skeleton with GET /health and smoke test ([be58c3e](https://github.com/Roxabi/roxabi-live/commit/be58c3e4f45296a059ddc0a1ffc7a975b0b295f1))
* **auth:** GitHub App + OAuth login + sessions (Phase 1 S2) ([2ba9557](https://github.com/Roxabi/roxabi-live/commit/2ba95571c720c66fb855dbd2f2f801f1c40dd7f0))
* **auth:** GitHub App JWT signer + OAuth login + D1 sessions ([#145](https://github.com/Roxabi/roxabi-live/issues/145)) ([240c490](https://github.com/Roxabi/roxabi-live/commit/240c490eef7cd5bd03294777a380a5fdc73c1db3))
* **corpus:** add lane/priority/size/status columns to issues schema ([62888f2](https://github.com/Roxabi/roxabi-live/commit/62888f2a0d34da34a8037bf8a23cfb7fe67590ff))
* **corpus:** add repo_allowlist table, sync filter, and CLI subcommand ([9befd89](https://github.com/Roxabi/roxabi-live/commit/9befd8992992e6af2a113b98e0a6edacea8dd8cf))
* **corpus:** drop ProjectV2, source size/priority/lane from labels ([#63](https://github.com/Roxabi/roxabi-live/issues/63)) ([2f3e6bd](https://github.com/Roxabi/roxabi-live/commit/2f3e6bd43e801562b557c05f7c03da4670801949))
* **corpus:** hydrate projectV2 fields via GraphQL extension ([4785ee3](https://github.com/Roxabi/roxabi-live/commit/4785ee3f9b925db2028a90a1dbf387461b57af2e))
* **corpus:** hydrate projectV2 fields, swap dep-graph reader ([#872](https://github.com/Roxabi/roxabi-live/issues/872)) ([1d8b1dc](https://github.com/Roxabi/roxabi-live/commit/1d8b1dc376d9d090e5d790abbc3df9fdcfc43511))
* **corpus:** hydrate projectV2 fields, swap dep-graph reader ([#872](https://github.com/Roxabi/roxabi-live/issues/872)) ([1d8b1dc](https://github.com/Roxabi/roxabi-live/commit/1d8b1dc376d9d090e5d790abbc3df9fdcfc43511))
* **corpus:** prune stale repos + public-only filter + --full CLI flag ([ac776d9](https://github.com/Roxabi/roxabi-live/commit/ac776d93a6639e380f899ced59a008284b621973))
* **corpus:** sync private repos too ([8851517](https://github.com/Roxabi/roxabi-live/commit/88515177d9ea30696d480faf88fb8bedd2b99ad6))
* **corpus:** sync private repos with opt-in allowlist ([d1b444a](https://github.com/Roxabi/roxabi-live/commit/d1b444a62d578e56ddb0a422592478e470374612))
* **corpus:** use GitHub native subIssues/parent/blockedBy/blocking ([6eecd09](https://github.com/Roxabi/roxabi-live/commit/6eecd09c70df7c2965c15cda9732a635866c0249))
* cutover to live.roxabi.dev — CF Workers production (S9 [#101](https://github.com/Roxabi/roxabi-live/issues/101), epic [#92](https://github.com/Roxabi/roxabi-live/issues/92)) ([3e8d12b](https://github.com/Roxabi/roxabi-live/commit/3e8d12b51f7101eaba5ee8f1c2f09b9064b8f4de))
* **dep-graph:** make v6 the default ([6e12ad4](https://github.com/Roxabi/roxabi-live/commit/6e12ad41055dac726d37cd010887726baa8c329b))
* **dep-graph:** pulse + satellite animations for dev/PR state ([#83](https://github.com/Roxabi/roxabi-live/issues/83)) ([fbfde37](https://github.com/Roxabi/roxabi-live/commit/fbfde37867a3a8156593cd04063bdfa944a5c5c5))
* **deploy:** S9 live.roxabi.dev custom-domain route + cutover runbook ([#101](https://github.com/Roxabi/roxabi-live/issues/101)) ([7f5c42f](https://github.com/Roxabi/roxabi-live/commit/7f5c42fb64f7285416ef6879d523ca909706658a))
* **deploy:** S9 live.roxabi.dev custom-domain route + runbook ([d769756](https://github.com/Roxabi/roxabi-live/commit/d769756392604f80431c02d509a863638e77cad5))
* **frontend:** dep-graph toolbar — fix repo filter, add label filter, show milestone/priority names ([3a26a68](https://github.com/Roxabi/roxabi-live/commit/3a26a68d4adda7782eea7edc8ddf14ea8213f8b5))
* **frontend:** live-refresh dep-graph on corpus change ([23d8a5c](https://github.com/Roxabi/roxabi-live/commit/23d8a5c300f9d753085e33e1ccc528600f17c4e4))
* **frontend:** repo filter — archived repos last with separator ([a7df9d2](https://github.com/Roxabi/roxabi-live/commit/a7df9d27e324838a962f754ddf4f3634def1e9a4))
* **frontend:** repo filter — archived repos last with separator ([5f50dfa](https://github.com/Roxabi/roxabi-live/commit/5f50dfafcb50dee20d6475768017e9520f0fa4be))
* **frontend:** toolbar — repo fix, milestone/priority names, label filter ([089f605](https://github.com/Roxabi/roxabi-live/commit/089f605a66efa896246d453fcfca03bc8e0c2a69))
* **frontend:** wire v6 dep-graph assets via Workers-with-assets ([#99](https://github.com/Roxabi/roxabi-live/issues/99)) ([e354bda](https://github.com/Roxabi/roxabi-live/commit/e354bda331091c9e21bf183285b3f92ed4e93170))
* **frontend:** wire v6 dep-graph assets via Workers-with-assets ([#99](https://github.com/Roxabi/roxabi-live/issues/99)) ([b797e7e](https://github.com/Roxabi/roxabi-live/commit/b797e7e00aa9763edea5265c058367377865208d))
* **live:** serve v5.1 dep-graph from corpus.db, fix v6 schema ([d9f55f9](https://github.com/Roxabi/roxabi-live/commit/d9f55f983f02ed8e97e70f4887e41af67e38ecdb))
* **make:** add full-sync target to re-fetch all issues ([abf06d2](https://github.com/Roxabi/roxabi-live/commit/abf06d21732b522dc849393f4e1a8089d8431335))
* migrate dep-graph + corpus from lyra, rename to roxabi-live ([97a806f](https://github.com/Roxabi/roxabi-live/commit/97a806f11b320be402ef0d7eff932905206b742b))
* **roxabi-issues:** relocate issue-triage plugin from dev-core ([e734697](https://github.com/Roxabi/roxabi-live/commit/e734697b83d6437c61e7b3f708caa923fc9dd196))
* **roxabi-issues:** relocate issue-triage plugin from dev-core ([240f7bc](https://github.com/Roxabi/roxabi-live/commit/240f7bc2354540c7ccb2b4419405b36f1eb23928))
* **schema:** 0004 tenancy/auth migration — 10 tables, title→payload, repo_node_id ([4a4e477](https://github.com/Roxabi/roxabi-live/commit/4a4e4777534d543d8f7665746dbd29995ce274b5)), closes [#144](https://github.com/Roxabi/roxabi-live/issues/144)
* **schema:** repo-canonical tenancy + auth migrations + CI/infra (S1) ([be90063](https://github.com/Roxabi/roxabi-live/commit/be900630934c0fff781072af532664a4ce5ed45d))
* **sync:** install-token infra + webhook cutover (Phase 1 S3a) ([5c51ba5](https://github.com/Roxabi/roxabi-live/commit/5c51ba5e8de9f5af50f1ccf71d41817f3e05289d))
* **sync:** install-token infrastructure + webhook cutover (Phase 1 S3a, [#146](https://github.com/Roxabi/roxabi-live/issues/146)) ([6967598](https://github.com/Roxabi/roxabi-live/commit/696759818ebc7b5970893d34911dccd390bec5f9))
* **sync:** per-installation runSync cutover + PAT retirement ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([84ee1f6](https://github.com/Roxabi/roxabi-live/commit/84ee1f6d48389d1198e99334e00c132c2404084c))
* **sync:** per-installation runSync cutover + PAT retirement (S3b) ([c43010e](https://github.com/Roxabi/roxabi-live/commit/c43010e591475834c79ce5cfb795b0e565368077))
* **v6:** "No milestone" row, list col alignment, group titles ([f8e43a8](https://github.com/Roxabi/roxabi-live/commit/f8e43a8e2f920a3de5fd6666ee03f3a93c913784))
* **v6:** add 'Closed' graph toggle to show closed issues under open epics ([ac2158a](https://github.com/Roxabi/roxabi-live/commit/ac2158a31029d0c3f48b3fd7bee0c7fdb921c10f))
* **v6:** add light/dark theme toggle ([3d1e687](https://github.com/Roxabi/roxabi-live/commit/3d1e68764cc22acff8733380e5e1ee75d95e0ce3))
* **v6:** add v5-style table grid, hover-chain highlighting, epic grouping ([6d42a82](https://github.com/Roxabi/roxabi-live/commit/6d42a8299c54aa7664326b5aa5c3d18455f4d3a4))
* **v6:** color repo filter pills to match node tones ([f6cfb45](https://github.com/Roxabi/roxabi-live/commit/f6cfb4520bfec74e2063aa4cf755c6d9f5845b36))
* **v6:** decouple repo tone palette from lanes ([6d9f741](https://github.com/Roxabi/roxabi-live/commit/6d9f741024b2c7b39578bc0b153ca8eb83e50a1a))
* **v6:** distinguish parent nodes from leaf issues with rounded-square style ([b161d11](https://github.com/Roxabi/roxabi-live/commit/b161d11c4a8a888e7cedb6b740fe6a6cad70ceea))
* **v6:** enrich API + build v6 frontend POC ([b4de423](https://github.com/Roxabi/roxabi-live/commit/b4de423f4380b440e4245af69bbc7646487fa0f9))
* **v6:** hide parent nodes when showParents=false ([7cd3507](https://github.com/Roxabi/roxabi-live/commit/7cd3507c08617d6b344c6f1944c4562667e95a98))
* **v6:** multi-select filters, list table, graph view from v5.1 SVG ([ddc75b0](https://github.com/Roxabi/roxabi-live/commit/ddc75b0291bbf9fa123301dff9b75a9083922424))
* **v6:** propagate 'blocked' status through parent → child edges ([36dc6a1](https://github.com/Roxabi/roxabi-live/commit/36dc6a10211776f4d402d98d0b5f4509a14becbb))
* **v6:** remove dot indicator and show issue size in graph labels ([00d3a04](https://github.com/Roxabi/roxabi-live/commit/00d3a04cc4abfccf55178152ba7259b47faabd41))
* **v6:** two-level table grouping, parent edges toggle, epic header polish ([0478a86](https://github.com/Roxabi/roxabi-live/commit/0478a865952aa8c82087d0be3ffda1483f321965))
* **webhook:** handle milestone renamed event to update corpus.db ([dabea24](https://github.com/Roxabi/roxabi-live/commit/dabea2471a78866070e09f82bb4f768f6f056dfd))
* **webhook:** handle milestone renamed event to update corpus.db ([0de5e98](https://github.com/Roxabi/roxabi-live/commit/0de5e98d96fb789f05934b18e28e501fc9a484a3)), closes [#104](https://github.com/Roxabi/roxabi-live/issues/104)
* **worker:** ADMIN_TOKEN auth on /admin/* (defense-in-depth, [#123](https://github.com/Roxabi/roxabi-live/issues/123)) ([8636a13](https://github.com/Roxabi/roxabi-live/commit/8636a13e77bb4ff48f1df76923f3979f460cb785))
* **worker:** ADMIN_TOKEN auth on /admin/* (defense-in-depth, [#123](https://github.com/Roxabi/roxabi-live/issues/123)) ([65e6ca0](https://github.com/Roxabi/roxabi-live/commit/65e6ca044e93dc10d1aa9a31203ee95990a8cb21))
* **worker:** bump data_version on webhook writes for live-refresh ([cd32b69](https://github.com/Roxabi/roxabi-live/commit/cd32b69dac4f9b9eb42249f645bdf1f8c31f006e))
* **worker:** bump data_version on webhook writes for live-refresh ([90fa619](https://github.com/Roxabi/roxabi-live/commit/90fa619c0534a8f3c7fe2260b9015771d3a9fb58)), closes [#133](https://github.com/Roxabi/roxabi-live/issues/133)
* **worker:** CF S8 cron + observability — Logpush→R2, halt alerts ([#100](https://github.com/Roxabi/roxabi-live/issues/100)) ([8734a06](https://github.com/Roxabi/roxabi-live/commit/8734a062af3a8116a67af58a80ad0b417ba31368))
* **worker:** GitHub GraphQL transport via fetch() + query ports ([#95](https://github.com/Roxabi/roxabi-live/issues/95)) ([71aba6f](https://github.com/Roxabi/roxabi-live/commit/71aba6f456d3a151ca32490d64b0151be2202d69))
* **worker:** per-run R2 audit summary — Free-plan Logpush alternative ([#120](https://github.com/Roxabi/roxabi-live/issues/120)) ([6b8c2c1](https://github.com/Roxabi/roxabi-live/commit/6b8c2c1fdb28d48bf0982a9c1a33ae25ef784ed1))
* **worker:** per-run R2 audit summary — Free-plan Logpush alternative ([#120](https://github.com/Roxabi/roxabi-live/issues/120)) ([b4affd5](https://github.com/Roxabi/roxabi-live/commit/b4affd507fa497d7dfb98ecb41943bf19a836c4e))
* **worker:** port corpus sync engine to D1 cron (S4, [#96](https://github.com/Roxabi/roxabi-live/issues/96)) ([f01368d](https://github.com/Roxabi/roxabi-live/commit/f01368d50e57ec4e09112ce722b6b2c44a247d81))
* **worker:** port corpus sync engine to D1 cron (S4, [#96](https://github.com/Roxabi/roxabi-live/issues/96)) ([9bb7674](https://github.com/Roxabi/roxabi-live/commit/9bb76748194e51b3f776b56ee336f880f1ea15a8))
* **worker:** port GitHub GraphQL transport to fetch() ([#95](https://github.com/Roxabi/roxabi-live/issues/95)) ([e511de0](https://github.com/Roxabi/roxabi-live/commit/e511de040231a91369e212eda09f6e9e9999d5cd))
* **worker:** port webhook mutations + HMAC verify (S5, [#97](https://github.com/Roxabi/roxabi-live/issues/97)) ([94e91ee](https://github.com/Roxabi/roxabi-live/commit/94e91ee6ea01912c558251595514374306de075b))
* **worker:** provision staging+prod D1, wire IDs, apply 0001 schema ([#94](https://github.com/Roxabi/roxabi-live/issues/94)) ([1ade933](https://github.com/Roxabi/roxabi-live/commit/1ade933039f110a9e333128145a24cb44840e47c))
* **worker:** provision staging+prod D1, wire IDs, apply 0001 schema ([#94](https://github.com/Roxabi/roxabi-live/issues/94)) ([1de2c0b](https://github.com/Roxabi/roxabi-live/commit/1de2c0b1bee9ae9e0a8c281d1f4c497e97498488))
* **worker:** S6 API endpoints — /api/issues, /api/graph (v6 port), /admin/sync ([#98](https://github.com/Roxabi/roxabi-live/issues/98)) ([7340633](https://github.com/Roxabi/roxabi-live/commit/7340633fb30c95158cb15ef1e05843ed88a9b12d))
* **worker:** S6 API endpoints — issues, graph, admin sync ([#98](https://github.com/Roxabi/roxabi-live/issues/98)) ([84a03ae](https://github.com/Roxabi/roxabi-live/commit/84a03ae92bc7308c2b5771fec4083280e375a6f6))
* **worker:** S8 observability — Workers Logs, typed NOTIFY_URL, halt-alert tests ([#100](https://github.com/Roxabi/roxabi-live/issues/100)) ([ac02dad](https://github.com/Roxabi/roxabi-live/commit/ac02dada1ee7668b7e01fadeabd270041e63481a))
* **worker:** scaffold Cloudflare Worker — router, D1, /api/version ([797d1fe](https://github.com/Roxabi/roxabi-live/commit/797d1fe2e9a8fac944e7d6b899fb65095706a9d7))
* **worker:** scaffold Cloudflare Worker — wrangler.toml, Hono router, D1 migrations, /api/version ([#93](https://github.com/Roxabi/roxabi-live/issues/93)) ([ce020b2](https://github.com/Roxabi/roxabi-live/commit/ce020b2921848b5914bcc9dbe75003164d78e21d))
* **worker:** sync prune for renamed/deleted repos + archived-repo tracking + /api/graph repos ([fc6087f](https://github.com/Roxabi/roxabi-live/commit/fc6087f07f28800995238f20599a3f6de5ca41bb))
* **worker:** sync prune renamed/deleted repos + archived tracking + /api/graph repos ([a6b414c](https://github.com/Roxabi/roxabi-live/commit/a6b414c60e7c4e7eaa8ad401fe811e0960712b56))
* **worker:** title→payload write/read paths + tenant-scoped sync_control ([d116d6f](https://github.com/Roxabi/roxabi-live/commit/d116d6f7cb9655d9b91679243b7fc3fe9d492da8)), closes [#144](https://github.com/Roxabi/roxabi-live/issues/144)
* **worker:** webhook dispatch + 7 handlers + primitive tests (S5, [#97](https://github.com/Roxabi/roxabi-live/issues/97)) ([5a9c905](https://github.com/Roxabi/roxabi-live/commit/5a9c905c04145377423d09172b6768db2b70c6c5))
* **worker:** webhook handlers + HMAC-SHA256 via Web Crypto ([#97](https://github.com/Roxabi/roxabi-live/issues/97)) ([afca4e0](https://github.com/Roxabi/roxabi-live/commit/afca4e0dce78ec0791a4857df5b100c00f099d2a))


### Bug Fixes

* **#43:** close spec-compliance gap missed by PR [#55](https://github.com/Roxabi/roxabi-live/issues/55) ([858a94d](https://github.com/Roxabi/roxabi-live/commit/858a94d5328c8923a4868f4050e72def65b0d20d))
* **#43:** close spec-compliance gap missed by PR [#55](https://github.com/Roxabi/roxabi-live/issues/55) ([5ee3a39](https://github.com/Roxabi/roxabi-live/commit/5ee3a39fdbb0d8aaedac61cd77d423077add4981))
* **auth:** address /code-review findings — test fidelity + hardening ([#146](https://github.com/Roxabi/roxabi-live/issues/146)) ([e7d101c](https://github.com/Roxabi/roxabi-live/commit/e7d101c7777162637b2697ba4be162341bcb742f))
* **auth:** harden OAuth callback + session typing per review ([ee192ab](https://github.com/Roxabi/roxabi-live/commit/ee192aba3167adedf1eb63a2e2e71c376cbf9666))
* **auth:** pre-merge hardening — install-token key guards + test rigor ([#146](https://github.com/Roxabi/roxabi-live/issues/146)) ([04cc52e](https://github.com/Roxabi/roxabi-live/commit/04cc52ef1f469b3c85aca01eea378cd79502cf47))
* **ci:** cd into worker/ before wrangler secret put (deploy hotfix) ([7dbf512](https://github.com/Roxabi/roxabi-live/commit/7dbf512737ef189b205210702b767ef1fa573cec))
* **ci:** map app-secrets guard to GH_APP_* secret names ([#145](https://github.com/Roxabi/roxabi-live/issues/145)) ([14bcb7c](https://github.com/Roxabi/roxabi-live/commit/14bcb7c812b01289879d304f909a366dd952a36e))
* **ci:** run secret-inject steps from worker/ so --config ../wrangler.toml resolves ([c6b4518](https://github.com/Roxabi/roxabi-live/commit/c6b4518cffd472a63587ac4e3d244a67da707fdf))
* **corpus:** auto-discover canonical board by title convention ([b435134](https://github.com/Roxabi/roxabi-live/commit/b435134631f64e5b6c215b3986b6ea3c5449dd4d))
* **corpus:** auto-discover canonical board by title convention ([1b101f1](https://github.com/Roxabi/roxabi-live/commit/1b101f1c80d9876d450b861a273efb2e6eee25bc))
* **corpus:** migrate edges PK to include kind ([#61](https://github.com/Roxabi/roxabi-live/issues/61)) ([4149cb0](https://github.com/Roxabi/roxabi-live/commit/4149cb096c90f1bde5b9b326a36df4b26372eb0a))
* **corpus:** satisfy pyright strict on _parse_project_fields + update exemption ([e0b0ee2](https://github.com/Roxabi/roxabi-live/commit/e0b0ee242632b2366a05ea6f031b4ff9e78dc452))
* **corpus:** scope webhook heal to single repo and dedup concurrent triggers ([e2b8c06](https://github.com/Roxabi/roxabi-live/commit/e2b8c0617726c0cffd158aa168ce5710849cd58d))
* **corpus:** scope webhook heal to single repo and dedup concurrent triggers ([#75](https://github.com/Roxabi/roxabi-live/issues/75)) ([45fbf4b](https://github.com/Roxabi/roxabi-live/commit/45fbf4bd180b477d9ad5b9e3f1351d12b05d1ece))
* **deploy:** break routes inheritance to staging + runbook hardening ([#101](https://github.com/Roxabi/roxabi-live/issues/101)) ([8d4be46](https://github.com/Roxabi/roxabi-live/commit/8d4be466e008344691b7757af6b2f328f6171496))
* **frontend:** persist filters per-tab via sessionStorage ([bc55be8](https://github.com/Roxabi/roxabi-live/commit/bc55be800cf263705e323bc7a3e826e6fe0a66ea))
* **frontend:** repo filter lists only repos with issues (archived still last) ([64bc371](https://github.com/Roxabi/roxabi-live/commit/64bc371faae914e7e1718a632d2807b28957d2e7))
* **frontend:** repo filter lists only repos with issues (archived still last) ([ccf21c5](https://github.com/Roxabi/roxabi-live/commit/ccf21c56f5e73490068e38934977917cdc39b4d4))
* **lifespan:** apply schema migrations on startup ([cea9df6](https://github.com/Roxabi/roxabi-live/commit/cea9df60072e678e185cfc0d53c4cfe259b10ea0))
* **lifespan:** apply schema migrations on startup ([c313fb5](https://github.com/Roxabi/roxabi-live/commit/c313fb57d3c39a2904572623b0ff68b5de59244e))
* **reconciler:** [#79](https://github.com/Roxabi/roxabi-live/issues/79) force trigger_heal when deps actually changed ([#85](https://github.com/Roxabi/roxabi-live/issues/85)) ([4046c0a](https://github.com/Roxabi/roxabi-live/commit/4046c0a14637354aecab33b8bf830fcbcf419a65))
* **reconciler:** create SQLite connection inside worker thread ([acbbb02](https://github.com/Roxabi/roxabi-live/commit/acbbb026fd5a5cb80021f10494ee45d468936aab))
* **reconciler:** per-repo concurrency lock instead of global bool ([#86](https://github.com/Roxabi/roxabi-live/issues/86)) ([4854c38](https://github.com/Roxabi/roxabi-live/commit/4854c388ab819a449f931dbcf4f62b4d2a64ec49)), closes [#84](https://github.com/Roxabi/roxabi-live/issues/84)
* **review:** apply 14 verified review findings on PR [#153](https://github.com/Roxabi/roxabi-live/issues/153) ([c3b9812](https://github.com/Roxabi/roxabi-live/commit/c3b98125ccd21652584f2dbebc38beac5aafd333)), closes [#144](https://github.com/Roxabi/roxabi-live/issues/144)
* **schema:** recovery guard for sync_control rebuild in 0004 ([6783ce4](https://github.com/Roxabi/roxabi-live/commit/6783ce4f300cc4322b25b80e88eba46045b57b17)), closes [#144](https://github.com/Roxabi/roxabi-live/issues/144)
* **sync:** address /code-review findings — coherent breaker + cadence guard + coverage ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([ee9305b](https://github.com/Roxabi/roxabi-live/commit/ee9305b6cf6042c5f80fbe094ccfe7fbd7c85585))
* **sync:** address S3a code-review findings ([#146](https://github.com/Roxabi/roxabi-live/issues/146)) ([8ee3aaf](https://github.com/Roxabi/roxabi-live/commit/8ee3aaf09bea3533988adbd722d1539e2c082da7))
* **sync:** seed sync_started_at sync_control row (0006) ([6aa8980](https://github.com/Roxabi/roxabi-live/commit/6aa898064c2c45ae41067022e767849895873220))
* **sync:** seed sync_started_at sync_control row (0006) ([e13e730](https://github.com/Roxabi/roxabi-live/commit/e13e73085ab930e6f2b1a89e03ee8f48707951c2))
* **v6:** cap band gap in graph layout ([9c34193](https://github.com/Roxabi/roxabi-live/commit/9c341936c2a6a6a9b1c854943c2e86a5ccc62d54))
* **v6:** center list table headers ([3bed880](https://github.com/Roxabi/roxabi-live/commit/3bed880af6edadc0631634cd1331c82f4a9fa32c))
* **v6:** change default view — hide done issues, group by parent, hide parents ([0b8e831](https://github.com/Roxabi/roxabi-live/commit/0b8e8318448de937895c264003d02e14eba7ecc3))
* **v6:** color nodes by repo, not lane ([55dde2d](https://github.com/Roxabi/roxabi-live/commit/55dde2d2f968aadc40bcb3cec6877eb880100270))
* **v6:** correct depth computation on DAG paths (parents + blockers max) ([fca94d4](https://github.com/Roxabi/roxabi-live/commit/fca94d41ebd182d5861ee016d3a3507af1e1a167))
* **v6:** dedup repo color fallback to prevent collision with explicit map ([69dbd1a](https://github.com/Roxabi/roxabi-live/commit/69dbd1af6471f00d1c27c098f9e2ecdc8ca051fe))
* **v6:** fall back to per-repo tone when lane is unset ([fa8621d](https://github.com/Roxabi/roxabi-live/commit/fa8621d34852e9095a6d0a56291be402f6a82602))
* **v6:** fall back to per-repo tone when lane is unset ([4bb0ff6](https://github.com/Roxabi/roxabi-live/commit/4bb0ff61b9aa47cfdcda976c57b81fb47566834d))
* **v6:** graph edge positioning and lane colors ([45f892c](https://github.com/Roxabi/roxabi-live/commit/45f892c9f2249b5b52f3050272627008b00790d8))
* **v6:** lower Y_BOT to prevent last-row labels from being clipped ([4c65434](https://github.com/Roxabi/roxabi-live/commit/4c65434587a016fad55f8f197a9224fde5ed5c5d))
* **v6:** read lane/priority/size/status from corpus columns ([1a8012f](https://github.com/Roxabi/roxabi-live/commit/1a8012f9a73fb0a9be93731322c1fce6cd8779e4))
* **v6:** read lane/priority/size/status from corpus columns ([12ac040](https://github.com/Roxabi/roxabi-live/commit/12ac04090e439b1bfa217161a68f15b16984d2e4))
* **v6:** restore lane label fallback in API ([dd9f4f0](https://github.com/Roxabi/roxabi-live/commit/dd9f4f034208b0ac5823560fe59de7479177d6ab))
* **v6:** restore lane label fallback in API ([00a7775](https://github.com/Roxabi/roxabi-live/commit/00a7775b4d321ed5b6277cf8f65f6d2649660c69))
* **v6:** show orange dot for blocked cards in table view ([4976852](https://github.com/Roxabi/roxabi-live/commit/4976852856b5cd442fc6dae96b2f828db9c27fe4))
* **v6:** tighten max band gap to 80px ([b994b78](https://github.com/Roxabi/roxabi-live/commit/b994b78b0dc816ca892db257269e7da8c0c3864c))
* **v6:** toolbar polish — segs, icons, click-outside, scrollbars ([61c78bf](https://github.com/Roxabi/roxabi-live/commit/61c78bff3b712b2ac10f5821f17b03ea941738fe))
* **v6:** unwrap /api/repos object in loadRepos ([e2b614f](https://github.com/Roxabi/roxabi-live/commit/e2b614fe0edf3d77f06d093cb3b25e9e3e24f82f))
* **webhook:** apply review findings — exception breadth, commit location, tautology test, asyncio.to_thread ([f12a860](https://github.com/Roxabi/roxabi-live/commit/f12a860956b1244d98354e93323d9ce7ec644131))
* **webhook:** correct sub_issues payload field names and guard malformed events ([b2c4280](https://github.com/Roxabi/roxabi-live/commit/b2c428018e317e7d9af55f495accc2e8aa76e19d))
* **webhook:** fallback to repository field when *_issue_repo keys absent ([b834b5d](https://github.com/Roxabi/roxabi-live/commit/b834b5deb5336236a3cffe03c98a0969355c8229))
* **webhook:** handle missing blocking_issue in issue_dependencies payload ([2090b9b](https://github.com/Roxabi/roxabi-live/commit/2090b9ba328ce2b5bbbaf9e26fa9a0f20363dafe))
* **webhook:** handle transferred action — delete source issue from corpus ([d7da78d](https://github.com/Roxabi/roxabi-live/commit/d7da78dfe7767c1dfb4ba3b12fd8ac95717f2ebc))
* **webhook:** point-fetch downstream issue deps on cross-repo blocked_by ([aa980f5](https://github.com/Roxabi/roxabi-live/commit/aa980f570dbcb3ba05346e5feb8fb986b0c513ea))
* **webhook:** point-fetch downstream issue deps on cross-repo blocked_by ([3ff2eff](https://github.com/Roxabi/roxabi-live/commit/3ff2efff9b06fec4c3288ff22cf6fc2e87114e2c)), closes [#77](https://github.com/Roxabi/roxabi-live/issues/77)
* **webhook:** propagate milestone and label-derived fields on issues events ([57c46f4](https://github.com/Roxabi/roxabi-live/commit/57c46f4db929a7bc35db28e20cb5a799a409180c))
* **worker:** apply review findings — webhook hardening (S5, [#97](https://github.com/Roxabi/roxabi-live/issues/97)) ([77d8069](https://github.com/Roxabi/roxabi-live/commit/77d8069c98f8b4b07970d7fc20429086605e458e))
* **worker:** drop unsupported PRAGMA journal_mode from D1 migration ([c3bd5cc](https://github.com/Roxabi/roxabi-live/commit/c3bd5cc3c9a628c9169fe36e39e493d567597a39))
* **worker:** S6 review — lane parity, limit/offset clamp, SQL-dispatch test stubs ([#116](https://github.com/Roxabi/roxabi-live/issues/116)) ([5d6eedb](https://github.com/Roxabi/roxabi-live/commit/5d6eedb8eee5eb2894c732a713a5a722942b6d11))


### Performance Improvements

* **api:** gzip-compress responses via GZipMiddleware ([#88](https://github.com/Roxabi/roxabi-live/issues/88)) ([aeb122e](https://github.com/Roxabi/roxabi-live/commit/aeb122e517b7156cbef98d4090e524afddb0ac1e))
* **startup:** schedule reconciler sync in background, non-blocking lifespan ([#90](https://github.com/Roxabi/roxabi-live/issues/90)) ([f713a6d](https://github.com/Roxabi/roxabi-live/commit/f713a6d749a77aae674cc077ddc7d461c3b3745a)), closes [#89](https://github.com/Roxabi/roxabi-live/issues/89)
* **sync:** 1 GraphQL query/repo to fit Workers subrequest cap (+ S5 spec fix) ([#110](https://github.com/Roxabi/roxabi-live/issues/110)) ([d366b93](https://github.com/Roxabi/roxabi-live/commit/d366b93d60c339dd2e82a96d5b0589032434604f))


### Documentation

* add README, getting-started guide, and CONTRIBUTING ([94acfd0](https://github.com/Roxabi/roxabi-live/commit/94acfd09900a82a1a6e1e80b67f98fd8f49f8f06))
* **analysis:** multi-tenant GitHub App auth — Phase 1 shapes, review-hardened ([#141](https://github.com/Roxabi/roxabi-live/issues/141)) ([19615ab](https://github.com/Roxabi/roxabi-live/commit/19615ab10b5c93a480c2096caecbf941e0849bcd))
* **analysis:** per-installation runSync cutover shapes + architect review ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([4dd0809](https://github.com/Roxabi/roxabi-live/commit/4dd0809bfbc1e044c44e2ed23b2ed15b69c032c9))
* **analysis:** zero-knowledge encryption + multi-tenant GitHub auth spike ([4421bec](https://github.com/Roxabi/roxabi-live/commit/4421bec2c5898739691ff6cd2e7ef02ee92c72ff))
* **claude:** update deploy pattern — systemd unit replaces supervisor ([050c76a](https://github.com/Roxabi/roxabi-live/commit/050c76a5f7252db3de8a57d2af071265254f8f94))
* **cloudflared:** drop stale 'and FastAPI' references in stop step ([6565b58](https://github.com/Roxabi/roxabi-live/commit/6565b587068fbf3ddc5a2649a7f658545ad0629c))
* correct stale roxabi.dev zone status (now on Cloudflare) + supervisor→systemd notes ([552879c](https://github.com/Roxabi/roxabi-live/commit/552879cd7916f196e245e8775a25ddab5c7b4f87))
* correct stale roxabi.dev zone status (now on Cloudflare) + supervisor→systemd notes ([df899be](https://github.com/Roxabi/roxabi-live/commit/df899be33bf3dce4ed7f430514612cd0c73a9244))
* **frame:** [#100](https://github.com/Roxabi/roxabi-live/issues/100) CF S8 cron + observability — tier S ([e0bb135](https://github.com/Roxabi/roxabi-live/commit/e0bb13578ee2b64ca367648ef0f67c1c9184c267))
* **frame:** [#57](https://github.com/Roxabi/roxabi-live/issues/57) migrate edges PK to include kind ([a2a0bf8](https://github.com/Roxabi/roxabi-live/commit/a2a0bf8b1e11eded93f7d0ef3f97c469c0d9c7c9))
* **frame:** [#58](https://github.com/Roxabi/roxabi-live/issues/58) webhook layer cleanup ([1096a84](https://github.com/Roxabi/roxabi-live/commit/1096a84381137060e7347adcdccac4c5beb03ecd))
* **frame:** [#82](https://github.com/Roxabi/roxabi-live/issues/82) node animation proposals ([dbccb81](https://github.com/Roxabi/roxabi-live/commit/dbccb81fd5efeb8bc92f040083b9c3f89344c993))
* **frame:** [#82](https://github.com/Roxabi/roxabi-live/issues/82) pulse + satellite animations for dev/PR state ([821cb68](https://github.com/Roxabi/roxabi-live/commit/821cb68bf7b4c03b9c7ab57de2ccff36f95ecc04))
* **frame:** approve frame for per-installation runSync cutover ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([6cd0e99](https://github.com/Roxabi/roxabi-live/commit/6cd0e995ffe17211c1926803325268399b0bf350))
* **frame:** multi-tenant GitHub App auth — Phase 1 ([#141](https://github.com/Roxabi/roxabi-live/issues/141)) ([7e26f0a](https://github.com/Roxabi/roxabi-live/commit/7e26f0a3719f2688d061b1d6ddcbc5dcbb723e12))
* migrate [#866](https://github.com/Roxabi/roxabi-live/issues/866) artifacts (corpus live access) ([f312563](https://github.com/Roxabi/roxabi-live/commit/f3125630281bff43452daf9931ef10c47e8da498))
* migrate corpus live access artifacts from lyra[#866](https://github.com/Roxabi/roxabi-live/issues/866) (roxabi-dashboard[#43](https://github.com/Roxabi/roxabi-live/issues/43)) ([5d66b66](https://github.com/Roxabi/roxabi-live/commit/5d66b6614c04d2423097a8132d808804e1a7d00a))
* **plan:** [#144](https://github.com/Roxabi/roxabi-live/issues/144) S1 plan — migration 0004, payload refactor, CI/infra ([e79433d](https://github.com/Roxabi/roxabi-live/commit/e79433da8b8e28fad36384bf690a31de8c7b25af))
* **plan:** [#145](https://github.com/Roxabi/roxabi-live/issues/145) github-app-oauth-sessions — 13 micro-tasks, 4 waves ([9c677b6](https://github.com/Roxabi/roxabi-live/commit/9c677b60420ca34b5068472c9e9739861848bf21))
* **plan:** [#54](https://github.com/Roxabi/roxabi-live/issues/54) drop ProjectV2, source size/priority/lane from labels ([9a34e1f](https://github.com/Roxabi/roxabi-live/commit/9a34e1f9be1baebfa7cf642e48dbf6909567b9ef))
* **plan:** [#56](https://github.com/Roxabi/roxabi-live/issues/56) harden public API surface (4 slices, 12 tasks) ([1561fbb](https://github.com/Roxabi/roxabi-live/commit/1561fbbcac324c7d8a57b160a4b7a41026567bde))
* **plan:** [#57](https://github.com/Roxabi/roxabi-live/issues/57) migrate edges PK to include kind ([8bb6969](https://github.com/Roxabi/roxabi-live/commit/8bb6969c21723fd40034819e8c4ba151cf833b44))
* **plan:** [#58](https://github.com/Roxabi/roxabi-live/issues/58) webhook layer cleanup ([11f5a80](https://github.com/Roxabi/roxabi-live/commit/11f5a809c23a13e9fe56d5af41cca8629e028f22))
* **plan:** [#58](https://github.com/Roxabi/roxabi-live/issues/58) webhook layer cleanup ([7822921](https://github.com/Roxabi/roxabi-live/commit/7822921d7c0f48a5a879d0a0687b778c368e9c2f))
* **plan:** [#82](https://github.com/Roxabi/roxabi-live/issues/82) pulse + satellite animations for dev/PR state ([2944c06](https://github.com/Roxabi/roxabi-live/commit/2944c06d89a503ac6f9dbf6801911ddf3dc6be41))
* **plan:** [#98](https://github.com/Roxabi/roxabi-live/issues/98) CF S6 API endpoints plan ([bc26c8d](https://github.com/Roxabi/roxabi-live/commit/bc26c8ddcc7801c3d5fa85bebc220a736fff10d7))
* **plan:** per-installation runSync cutover — 10 micro-tasks + waves ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([fd6d75c](https://github.com/Roxabi/roxabi-live/commit/fd6d75c5c228f144e8a3e8f07dc1bbad6d1458fc))
* **plan:** S5 webhook handlers port plan ([#97](https://github.com/Roxabi/roxabi-live/issues/97)) ([c71408c](https://github.com/Roxabi/roxabi-live/commit/c71408cdf99774cf6e9c1135924073c493bbfb35))
* **readme,claude:** document the roxabi-issues plugin ([b479fff](https://github.com/Roxabi/roxabi-live/commit/b479fffd626d963e45d717a0ec45b463b3383463))
* **readme,claude:** document the roxabi-issues plugin ([2949736](https://github.com/Roxabi/roxabi-live/commit/294973691104f5c6fc8490406e3ed5d9ef00b276))
* **readme:** realign to Cloudflare Worker + D1 architecture ([5d6d25b](https://github.com/Roxabi/roxabi-live/commit/5d6d25bd3c172fe8ac3556dfce865ef4f6fab565))
* recapture screenshots with new default view settings ([17e7b6f](https://github.com/Roxabi/roxabi-live/commit/17e7b6f0789930d7e9b3f4fb38475fd546da2f42))
* reflect CF cutover — prod on Worker, M₁ decommissioned ([#92](https://github.com/Roxabi/roxabi-live/issues/92)) ([67c80ee](https://github.com/Roxabi/roxabi-live/commit/67c80ee146f40b47a0df11c0186136fac9d6af01))
* reflect CF cutover — prod on Worker, M₁ decommissioned ([#92](https://github.com/Roxabi/roxabi-live/issues/92)) ([552aeca](https://github.com/Roxabi/roxabi-live/commit/552aeca5462b54af840fb57624f3ad363012d21f))
* **spec:** [#54](https://github.com/Roxabi/roxabi-live/issues/54) drop ProjectV2, source size/priority/lane from labels ([51976da](https://github.com/Roxabi/roxabi-live/commit/51976da3a7a358aaab5dca5f9430e4ae8480a7d9))
* **spec:** [#57](https://github.com/Roxabi/roxabi-live/issues/57) migrate edges PK to include kind ([6ac90ee](https://github.com/Roxabi/roxabi-live/commit/6ac90ee959623fa284c2177828a39556acf1c210))
* **spec:** [#58](https://github.com/Roxabi/roxabi-live/issues/58) webhook layer cleanup ([40f3f71](https://github.com/Roxabi/roxabi-live/commit/40f3f71018cb9488b9f5a6eef6ea930334aafc39))
* **spec:** [#82](https://github.com/Roxabi/roxabi-live/issues/82) pulse + satellite animations for dev/PR state ([2920ab4](https://github.com/Roxabi/roxabi-live/commit/2920ab4d8c2eb7e23419a16ee9ee79eb95981373))
* **spec:** [#92](https://github.com/Roxabi/roxabi-live/issues/92) Cloudflare serverless migration spec ([efd5b5f](https://github.com/Roxabi/roxabi-live/commit/efd5b5f7670ac4e63d67a08c159cc51dd4bed1ac))
* **spec:** [#92](https://github.com/Roxabi/roxabi-live/issues/92) Cloudflare serverless migration spec & sliced plan ([dcc46e3](https://github.com/Roxabi/roxabi-live/commit/dcc46e3d3e64dfea1c319af033fa879b421641b2))
* **spec:** drop unsupported WAL PRAGMA + fix Go/No-Go column ref ([1c5e309](https://github.com/Roxabi/roxabi-live/commit/1c5e30997ee22567e79f96ad36c1374fd2f0a7b6))
* **spec:** multi-tenant GitHub App auth — Phase 1, 7-slice split, review-hardened ([#141](https://github.com/Roxabi/roxabi-live/issues/141)) ([92a64e5](https://github.com/Roxabi/roxabi-live/commit/92a64e5ed08680aa8858c2e95ed71d87fceb8aa9))
* **spec:** multi-tenant GitHub App auth Phase 1 — planning baseline + [#141](https://github.com/Roxabi/roxabi-live/issues/141) decomposition ([72740e5](https://github.com/Roxabi/roxabi-live/commit/72740e5fe508880c2c01a0a9337bf1f6efa4d535))
* **spec:** per-installation runSync cutover spec — architect+devops reviewed ([#160](https://github.com/Roxabi/roxabi-live/issues/160)) ([1f49c7a](https://github.com/Roxabi/roxabi-live/commit/1f49c7ade6113303e2751336a71a945aea1469b2))
* **spec:** repo-canonical pivot — amend [#141](https://github.com/Roxabi/roxabi-live/issues/141) specs + analysis addendum ([f5a6728](https://github.com/Roxabi/roxabi-live/commit/f5a6728f34c3ef92bd256edb834b7facfb06e737))
* **spec:** repo-canonical pivot — amend [#141](https://github.com/Roxabi/roxabi-live/issues/141) specs + analysis addendum ([a9d4e71](https://github.com/Roxabi/roxabi-live/commit/a9d4e71fd8d19211cba2e23fb85d5b67ef6b64f9))
* **spec:** sub-specs for [#141](https://github.com/Roxabi/roxabi-live/issues/141) decomposition (S1–S7 → [#144](https://github.com/Roxabi/roxabi-live/issues/144)–[#150](https://github.com/Roxabi/roxabi-live/issues/150)) ([40731c1](https://github.com/Roxabi/roxabi-live/commit/40731c1b07f4829eb47b8c80abffd5dd2751cc3b))
* switch ingress from cloudflared to Tailscale Funnel ([cebec9e](https://github.com/Roxabi/roxabi-live/commit/cebec9e6636863168b8030b0a3d1c55e8cfebb69))
* update deployment docs — supervisord → systemd user unit ([a8710a7](https://github.com/Roxabi/roxabi-live/commit/a8710a7bfbdcd17d5e440e33a8e5dd401f9039b0))
