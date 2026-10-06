-- Historical evidence backfill (Batch D). METADATA ONLY.
--
-- ************************************************************************
-- *  DO NOT APPLY THIS EXACT FILE TO PRODUCTION WITHOUT RE-AUDITING.      *
-- *  Its row IDs come from the read-only snapshot of 2026-10-06T07:30:48Z.  *
-- *  Before any rollout, re-run the read-only Production analysis and    *
-- *  regenerate / revalidate this plan; if Production changed, re-audit. *
-- ************************************************************************
--
-- Writes only two columns of consumption_logs: date_provenance and
-- source_count_item_id. inventory_count_items is not updated at all:
-- historical counted_at / counted_by / resolved_at / resolved_by /
-- resolution_details all stay NULL (they were never recorded, and are not
-- reconstructed — the audit_log keeps the historical resolution events).
--
-- Requires ADD_EVIDENCE_FOUNDATION.sql. Compatible with ADD_EVIDENCE_GUARD.sql
-- (it only fills NULL fields, which the guard allows). Safe to re-run: every
-- statement fills a field only while it is still NULL, so a second run changes
-- nothing. No quantity, date, amount, user, note, deletion flag, created_at or
-- link list is touched; nothing is inserted or deleted.
--
-- Every row/line below was selected from the data as of 2026-10-06T07:30:48Z (read-only
-- snapshot) by these deterministic rules — no scoring, no estimates:
--
-- 1. date_provenance = 'manual' (68 rows: 65 valid, 3 undone)
--    every log whose used_by is not the Stock Count user. None is classified
--    'manual_spread': no historical row carries durable proof that the log
--    editor's range spread created it.
-- 2. date_provenance = 'count_redated' (45 rows on 7 count lines)
--    the current rows of a line re-dated by Edit dates, proven by its
--    "Stock count edit: … re-dated from … to …" audit row: exactly one line of
--    that lot/unit in a count completed before the edit; every row listed in
--    the line's consumption_log_ids, is a correction of that lot, carries the
--    edit's note, lies inside the edit's target dates, was created within 60 s
--    of the audit row, and the rows total the audit's amount.
-- 3. date_provenance = 'historical_unknown' (34 rows)
--    every other Stock Count correction: whether its date was the default day
--    or chosen by hand cannot be reconstructed.
-- 4. source_count_item_id (79 rows)
--    a) 45 rows listed in exactly one line's consumption_log_ids
--       (correction of that line's lot);
--    b) 34 rows of lines without ids: correction of the line's lot,
--       created between its count's start and completion (+60 s), no other line
--       can claim it, and written within 60 s of that line's own resolution audit
--       row ("<name> — Lot <lot> — Physical count found …: <expected> → <counted>").
--       (The two in-progress counts deleted on 2026-09-19 applied no corrections:
--       their deletion audit rows carry no "corrections … left in place" note.)
--
-- Anomalies are reported, not repaired (kit3 / 0314: shortage 1 but two
-- correction rows — both stay and both are linked to that line; 8 re-dated
-- rows fall before their lot's received date and keep their dates; 12
-- corrected-to-match-count lines have no usage logs and get none).
--
-- Each statement re-checks the facts it relies on, so a row that changed
-- since the snapshot is skipped rather than mis-classified.

begin;

-- 1. manual
update consumption_logs
   set date_provenance = 'manual'
 where date_provenance is null
   and used_by <> 'Unlogged (physical count)'
   and id = any (array[
    'cc35d076-ec54-4920-87af-1b26d5fd970c',
    'f8a77ebd-69e2-4aba-830a-49add7a3a640',
    'f8580933-edb4-427e-8418-35409048219b',
    '8e10997a-60ac-488c-99bc-2870322ef82a',
    'dfff5ad9-2403-4127-a7fb-3c626df06406',
    'c3e7f903-800e-4642-9ace-227f836ed7d0',
    '11564899-2981-4962-9a99-390139ab823a',
    '54de3a2d-d50e-41aa-9602-ace732516a6d',
    '09c5453c-24a8-48d7-9381-b59a6b42e4e8',
    'e404680f-ba99-452c-a18d-cacb5416829e',
    '380478f6-2c42-4d41-99fe-c2256f02b25b',
    'fae01bae-f342-4789-891a-017265e10ed6',
    '5e7e07bd-6da1-4dae-a02b-0e4557beee0f',
    '434a7621-f716-4d06-ae6b-01dfbb091879',
    '29635e93-e8f3-4888-8d03-fb43a19f2160',
    '1fb9de84-a60b-4a00-9baf-ab00732827b0',
    '7e9431e8-2734-41f7-b1e2-45120723b791',
    'b1652be9-cfce-4da6-83bd-0bac9d5154e9',
    'f67cd5db-91ad-4316-aa66-d1fe911d6dde',
    '48bdc478-6b29-4720-964d-d5c2bdf764fe',
    '715f1ec8-4ed0-47b2-84c1-9faef9e8bcee',
    '9a7d82f6-aebb-4e3f-bda4-96b9bb137980',
    '050ff32b-757b-4caa-9c7f-79026910f7e8',
    '0df3a27a-d4ce-48e8-bfaa-10e936c85eb9',
    'c650033b-354d-4f45-966c-e0aa10942113',
    '2400d077-ae51-4989-94e0-995c0960cd2f',
    '98e7ea8d-5a31-4634-85e0-3485733bb312',
    '1d19e496-f08d-47f3-b86f-8d069fb7883f',
    'b4cccd30-601d-4252-ab11-3eead236d0fe',
    '14eacead-2dd8-46f7-9651-110fbf41c072',
    '28a622b5-8700-4a63-bfef-9adf07bce997',
    'a8c5ebef-1691-4491-93c1-41bedacaaa48',
    '7bfdb7cb-0e0f-497e-b3bf-6dd939d611a7',
    '7fcd725a-6ec9-4f76-a7fc-1d77f56cd7a4',
    '03f2177e-2795-4987-9b3b-9361595077ae',
    '225c9a12-aeb4-45b5-a185-51547d9440a5',
    '11a62d9f-8b24-447b-bf98-76552c5b98e9',
    'b10419af-d23d-474f-ae1e-ae274b3cb593',
    'bf4aef23-406c-4a56-89a1-9d3455b94431',
    '718b4985-7bfa-4de4-905a-11e74329f1d0',
    '2da712f6-d05f-4321-be87-a1218a9c345f',
    'f7a6f2c7-8cd5-445a-8a9a-c5ae782239cf',
    'f873bbdd-2fc5-420c-a77c-727b9f42cc62',
    '0fb0bb79-7e0d-44df-bcf9-e0fed866a433',
    '9b2deab2-694c-405f-8f4a-db882b25546f',
    'e5ea0df6-971e-45a0-9cfc-93876172731d',
    '22cf8e81-d083-495c-8126-c54a99ec2b56',
    '32ccdd8a-7e5b-405a-b285-f5890b47a43e',
    'be8d8b12-a5a3-4a9f-96ef-1ff83befb85d',
    '0dd37b02-83cc-4754-accb-e7513d8e73d8',
    'faea475d-1359-41b8-a01f-3977956ca9f6',
    '4ce48252-791d-4a4d-a846-0e37d6523229',
    '6156ea5c-e9da-4295-bbe9-d00098c0271f',
    '970d078b-0807-4904-a235-1960a38c92fc',
    '64379a8e-9c19-457e-a642-2e0b5ccc6f7d',
    '26e9e787-5fe0-4541-b0f0-0833b93cdf86',
    '11fedbd5-d989-4779-bc29-f3c2af515ee8',
    'd86f2c5b-274b-4ef5-89bd-33220aa7a81d',
    '94ae8779-5169-412e-bb9a-7ea91ea19d63',
    '3cd6d4e7-0214-433d-8187-e1e84aa158d1',
    '990894b4-099b-42b5-853f-eae73b21fc70',
    '95f259b7-1ce7-495d-9b1f-7ca7a29a469a',
    '83205ec2-4d51-4811-b76f-fa34be6aeb98',
    '2f029e60-6518-4ed7-add3-e11333d682da',
    '12592968-3337-4b53-b554-0f29a4332910',
    'db5ca71f-18b9-45c9-91a8-739ead487ada',
    '670b8ef3-827c-41ef-a85a-38eb0dbdf13c',
    '94938938-cd13-4aa6-9f7a-ea91f574a5fc'
   ]::uuid[]);

-- 2. count_redated
update consumption_logs
   set date_provenance = 'count_redated'
 where date_provenance is null
   and used_by = 'Unlogged (physical count)'
   and id = any (array[
    'b806f3e8-1afe-44c7-ba79-181994ecd8ab',
    'cc7bba81-1258-4f1b-9c5d-9828ee8a8bd0',
    'b900de60-4a83-47f6-b18f-e3d0cd0c7d87',
    '2eeffc45-da34-4ef4-9ba3-ffcb756db3b9',
    '7597e1fb-730a-4848-9eba-026f127b876c',
    'cd1a1d73-51cb-4bc5-9956-8c412b86834b',
    '5894c221-8e6e-4e64-9918-a6f1ef8b3031',
    'a923b31c-3856-440f-b05a-2d39661a05b6',
    'a5e7988f-d4d4-464b-9c96-12ae8da49082',
    'a53bc193-8361-4736-84e8-84cc1ce97e36',
    'ccfe6278-3ce1-4478-8d1d-3c45c97aa900',
    'fd5b2d97-6f74-466a-a946-5b6ccbd16c70',
    'b45b3741-ab15-45ec-9641-51170f9f0326',
    '64d64c02-f94f-4217-9de9-0538f5c4d1c1',
    '1e721d34-d230-4469-b39f-7badca4cf688',
    '62aa5535-5f0b-453d-9c13-46b1642380b5',
    '9efbd704-b9a4-416d-bfbc-6e0e82a63e7a',
    '906f2430-b1c6-4e77-ac89-e91a77e450a2',
    '915b2549-7a82-4c69-a8aa-56df18aa4f7e',
    '03dfaa88-5cee-4cfc-930e-960e33c07f59',
    '3f4cca2d-ba80-433f-9b3f-f70fb0e79da7',
    '6a1f7db0-a729-47de-9ca6-e76b9f4f1d69',
    '013725f3-f546-482c-bcd5-accc582bf238',
    '794d9a72-42aa-4de8-bb9b-4830c30dade9',
    '30be7e6d-ab64-4c16-bbbf-6fc79d216a54',
    '020e5fc1-44e7-4dfe-8e10-7ed26c2d8e6b',
    '945a450f-8d6e-47af-b4c9-5385f9b9a102',
    '917a095f-bf93-49fe-8e81-4f48063d07e4',
    '1bc5ed09-0032-48b1-8989-a6dda4d5cc9b',
    'f0d1d618-78ec-4598-9d8f-3ccc43fe920c',
    'f7d76792-ce5b-4cf1-8c52-6892e262afaa',
    'a1d7391a-e59c-4c35-9f7e-4553dae2a158',
    '0cea7941-fa4c-491a-8a3e-47bd50097296',
    '80b6c836-f569-4fa1-bce0-4ddaef51f48e',
    '3ea92765-868e-4eaf-866b-72a885429296',
    '77d85a4f-a759-4399-9562-81229cadb8b4',
    '8aa003b6-7947-442c-babc-5dfac9cd6a90',
    'f1e00223-7102-4bc5-97c0-82f306e045d5',
    'eb4ab5bf-4799-4bbc-a29d-7fc2d075fd13',
    '7fc64f97-0666-4606-8b3e-17696ab3fc48',
    '160f9a19-7211-4138-9edc-de039cff49f8',
    'ad682248-267a-485b-9253-91389786f94a',
    'e0722f75-dd8a-4930-8453-3d922b5f06db',
    '62fbe6a8-f22d-4035-aafc-09d43a81081a',
    '8e19fc4f-c776-48c8-adf1-69030ce2a477'
   ]::uuid[]);

-- 3. historical_unknown
update consumption_logs
   set date_provenance = 'historical_unknown'
 where date_provenance is null
   and used_by = 'Unlogged (physical count)'
   and id = any (array[
    '66f446e9-17ca-4f17-afc8-ac5b2613660a',
    '461e5ffd-99c8-405e-8246-592d4c057432',
    '90773378-ca22-4858-9200-b89c66f69882',
    '7b52be08-20a7-4bc8-886c-35f551602acb',
    'fa171a9f-7bf8-4e9e-9a89-93a03e4463e7',
    '2ac6cdc4-9093-412b-a35d-49676f5c6509',
    'cd5bb983-d9e2-4b32-b8d2-145a23794dcb',
    '563d789f-6265-4151-adcb-28fa6ee550cd',
    '520b9935-d6d0-4201-9782-ceaad022e585',
    'c7de623d-7315-462d-9c9b-001f7d9ad4f1',
    '8a012e21-bc0f-4e14-a803-b1ecda077b66',
    '0391150a-fc60-40fd-b243-75f8f8aac6a1',
    '4423f21a-4c54-415b-b222-371a0590cffb',
    'cf20433f-c12f-4502-b349-93cd9cd1ec7a',
    'a2f7791e-191e-4484-a6e0-c9df72021e7d',
    '3b8edad9-f1b8-463a-a2f7-2fa17223712a',
    'ec2b7765-eb62-456b-996d-e120c469a818',
    '527b8070-c063-40b4-b32b-aeb621dd8eae',
    'abf93e1c-57d6-4ee5-bb3d-a59928bfe089',
    'c96aafbb-66d2-4b53-b55d-d44cf30bd028',
    '100e3e47-d45f-45e5-9395-32455e91f203',
    '628619f3-d438-4c56-9355-5b6f3ff3a948',
    '5b04ddf1-ecd6-4d60-89ef-99bf786137a1',
    '18545473-467b-4297-8bbf-2577049e09f3',
    '90a251c7-1f01-4912-b740-7a381d1aa099',
    '04b8a498-6ed8-46cf-87c9-dc8f03829875',
    'd2c688ce-cb3d-4509-a9be-2e3c72c0869c',
    '4177e6f2-90fd-47a4-91cb-a2070c2afe08',
    'c790559c-c900-4bb1-9308-3821d549092d',
    '37e9ba69-5ea7-4fa5-b571-c75cb2076d5e',
    '6472e49c-ee6c-4cb1-860d-99c9b5ef7e21',
    '0ed77e02-7d61-48e2-8f84-37b1820a6cd2',
    '7b6072d3-cbca-4633-9d3b-6dc2dc27bd98',
    'e3507bf6-10b0-4c79-add9-d54e96f8a814'
   ]::uuid[]);

-- 4. source_count_item_id (correction row → its count line)
update consumption_logs l
   set source_count_item_id = v.line_id
  from (values
    ('3ea92765-868e-4eaf-866b-72a885429296'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('77d85a4f-a759-4399-9562-81229cadb8b4'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('8aa003b6-7947-442c-babc-5dfac9cd6a90'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('f1e00223-7102-4bc5-97c0-82f306e045d5'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('eb4ab5bf-4799-4bbc-a29d-7fc2d075fd13'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('7fc64f97-0666-4606-8b3e-17696ab3fc48'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('160f9a19-7211-4138-9edc-de039cff49f8'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('ad682248-267a-485b-9253-91389786f94a'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('e0722f75-dd8a-4930-8453-3d922b5f06db'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('62fbe6a8-f22d-4035-aafc-09d43a81081a'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('8e19fc4f-c776-48c8-adf1-69030ce2a477'::uuid, '358dcfec-5a62-46fa-93a7-293427a8860e'::uuid),
    ('b806f3e8-1afe-44c7-ba79-181994ecd8ab'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('cc7bba81-1258-4f1b-9c5d-9828ee8a8bd0'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('b900de60-4a83-47f6-b18f-e3d0cd0c7d87'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('2eeffc45-da34-4ef4-9ba3-ffcb756db3b9'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('7597e1fb-730a-4848-9eba-026f127b876c'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('cd1a1d73-51cb-4bc5-9956-8c412b86834b'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('5894c221-8e6e-4e64-9918-a6f1ef8b3031'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('a923b31c-3856-440f-b05a-2d39661a05b6'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('a5e7988f-d4d4-464b-9c96-12ae8da49082'::uuid, '2b068e1d-c033-40b0-8a5f-b6f7bd4824f2'::uuid),
    ('013725f3-f546-482c-bcd5-accc582bf238'::uuid, 'f8de2ad8-a195-494e-9320-e88e5bb3901d'::uuid),
    ('794d9a72-42aa-4de8-bb9b-4830c30dade9'::uuid, 'f8de2ad8-a195-494e-9320-e88e5bb3901d'::uuid),
    ('30be7e6d-ab64-4c16-bbbf-6fc79d216a54'::uuid, 'f8de2ad8-a195-494e-9320-e88e5bb3901d'::uuid),
    ('020e5fc1-44e7-4dfe-8e10-7ed26c2d8e6b'::uuid, 'f8de2ad8-a195-494e-9320-e88e5bb3901d'::uuid),
    ('945a450f-8d6e-47af-b4c9-5385f9b9a102'::uuid, 'f8de2ad8-a195-494e-9320-e88e5bb3901d'::uuid),
    ('a53bc193-8361-4736-84e8-84cc1ce97e36'::uuid, 'eb0c9471-7d6a-4ddc-b691-10e3f177eb25'::uuid),
    ('ccfe6278-3ce1-4478-8d1d-3c45c97aa900'::uuid, 'eb0c9471-7d6a-4ddc-b691-10e3f177eb25'::uuid),
    ('fd5b2d97-6f74-466a-a946-5b6ccbd16c70'::uuid, 'eb0c9471-7d6a-4ddc-b691-10e3f177eb25'::uuid),
    ('b45b3741-ab15-45ec-9641-51170f9f0326'::uuid, 'eb0c9471-7d6a-4ddc-b691-10e3f177eb25'::uuid),
    ('64d64c02-f94f-4217-9de9-0538f5c4d1c1'::uuid, 'eb0c9471-7d6a-4ddc-b691-10e3f177eb25'::uuid),
    ('1e721d34-d230-4469-b39f-7badca4cf688'::uuid, 'b294f219-6197-42ce-b13c-dc895984389e'::uuid),
    ('62aa5535-5f0b-453d-9c13-46b1642380b5'::uuid, 'b294f219-6197-42ce-b13c-dc895984389e'::uuid),
    ('9efbd704-b9a4-416d-bfbc-6e0e82a63e7a'::uuid, 'b294f219-6197-42ce-b13c-dc895984389e'::uuid),
    ('906f2430-b1c6-4e77-ac89-e91a77e450a2'::uuid, 'b294f219-6197-42ce-b13c-dc895984389e'::uuid),
    ('915b2549-7a82-4c69-a8aa-56df18aa4f7e'::uuid, 'b294f219-6197-42ce-b13c-dc895984389e'::uuid),
    ('03dfaa88-5cee-4cfc-930e-960e33c07f59'::uuid, '2b430db9-16e0-4e96-a16c-0736f9db6706'::uuid),
    ('3f4cca2d-ba80-433f-9b3f-f70fb0e79da7'::uuid, '2b430db9-16e0-4e96-a16c-0736f9db6706'::uuid),
    ('6a1f7db0-a729-47de-9ca6-e76b9f4f1d69'::uuid, '2b430db9-16e0-4e96-a16c-0736f9db6706'::uuid),
    ('917a095f-bf93-49fe-8e81-4f48063d07e4'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('1bc5ed09-0032-48b1-8989-a6dda4d5cc9b'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('f0d1d618-78ec-4598-9d8f-3ccc43fe920c'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('f7d76792-ce5b-4cf1-8c52-6892e262afaa'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('a1d7391a-e59c-4c35-9f7e-4553dae2a158'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('0cea7941-fa4c-491a-8a3e-47bd50097296'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('80b6c836-f569-4fa1-bce0-4ddaef51f48e'::uuid, '0159e82a-7bb9-490d-a026-5509099768b6'::uuid),
    ('66f446e9-17ca-4f17-afc8-ac5b2613660a'::uuid, '1e99e585-f7b7-4957-a405-e2016d3efec8'::uuid),
    ('461e5ffd-99c8-405e-8246-592d4c057432'::uuid, '52c37a8c-da95-4cd4-b757-3221a5b3089f'::uuid),
    ('90773378-ca22-4858-9200-b89c66f69882'::uuid, 'b252bf52-77aa-49cd-91d3-8fd0fefd6bb8'::uuid),
    ('7b52be08-20a7-4bc8-886c-35f551602acb'::uuid, '585823af-f9fc-4bef-95c7-814c15ccab6a'::uuid),
    ('fa171a9f-7bf8-4e9e-9a89-93a03e4463e7'::uuid, 'a6511a05-f687-4f0c-9137-87fed9bc21bd'::uuid),
    ('2ac6cdc4-9093-412b-a35d-49676f5c6509'::uuid, 'cc93ca20-7dd4-45ec-a1e6-73732eaba350'::uuid),
    ('cd5bb983-d9e2-4b32-b8d2-145a23794dcb'::uuid, '91c5aeba-c454-4b49-aeec-1253ddbdb490'::uuid),
    ('563d789f-6265-4151-adcb-28fa6ee550cd'::uuid, '9360da7b-bcad-4e12-ac9c-b58d4b9221be'::uuid),
    ('520b9935-d6d0-4201-9782-ceaad022e585'::uuid, '450e2626-28ea-48de-8456-810aac4114f0'::uuid),
    ('c7de623d-7315-462d-9c9b-001f7d9ad4f1'::uuid, 'f0ebf424-b3f7-41c1-ad33-e793329824a5'::uuid),
    ('8a012e21-bc0f-4e14-a803-b1ecda077b66'::uuid, '3f56bb26-d30c-4f2b-a7de-318966dbdb8a'::uuid),
    ('0391150a-fc60-40fd-b243-75f8f8aac6a1'::uuid, '3f56bb26-d30c-4f2b-a7de-318966dbdb8a'::uuid),
    ('4423f21a-4c54-415b-b222-371a0590cffb'::uuid, '59109072-cd37-4589-b36b-67ba43327bcf'::uuid),
    ('cf20433f-c12f-4502-b349-93cd9cd1ec7a'::uuid, 'b8d11d42-9954-4767-8747-ce5191a666e1'::uuid),
    ('a2f7791e-191e-4484-a6e0-c9df72021e7d'::uuid, 'a695b970-04cd-4df5-b6b7-2f07afb3983a'::uuid),
    ('3b8edad9-f1b8-463a-a2f7-2fa17223712a'::uuid, 'ac700653-a2b6-483a-9c63-6fe0088a01fe'::uuid),
    ('ec2b7765-eb62-456b-996d-e120c469a818'::uuid, '7e7b3716-0d0a-46a8-af6c-155c1e8ddcd2'::uuid),
    ('527b8070-c063-40b4-b32b-aeb621dd8eae'::uuid, '439cc18c-7736-4b72-a534-38aa4e91451b'::uuid),
    ('abf93e1c-57d6-4ee5-bb3d-a59928bfe089'::uuid, '49b2b86b-d1f7-4867-a1d8-6947841c527c'::uuid),
    ('c96aafbb-66d2-4b53-b55d-d44cf30bd028'::uuid, 'ebb2a4bd-ed84-4112-a00d-8c00651c41d3'::uuid),
    ('100e3e47-d45f-45e5-9395-32455e91f203'::uuid, '56e318c5-8483-4d43-89c2-b252fe4a98db'::uuid),
    ('628619f3-d438-4c56-9355-5b6f3ff3a948'::uuid, '11a4d59d-cad6-4d88-91a5-06ef44d77be4'::uuid),
    ('5b04ddf1-ecd6-4d60-89ef-99bf786137a1'::uuid, '007f8f8d-d4bc-4d33-85de-aaab4bf23188'::uuid),
    ('18545473-467b-4297-8bbf-2577049e09f3'::uuid, '644d78e7-4087-4b22-8cd3-1817f9bb2b8d'::uuid),
    ('90a251c7-1f01-4912-b740-7a381d1aa099'::uuid, '87450505-011f-4829-a4ad-235e2eeb3560'::uuid),
    ('04b8a498-6ed8-46cf-87c9-dc8f03829875'::uuid, '6634a952-72e1-4268-b315-d2d749513f16'::uuid),
    ('d2c688ce-cb3d-4509-a9be-2e3c72c0869c'::uuid, 'b5f54914-eb50-49b6-a11e-cd233f1f9ae2'::uuid),
    ('4177e6f2-90fd-47a4-91cb-a2070c2afe08'::uuid, '285c0b1b-7851-4f44-af31-a01b6bd628b5'::uuid),
    ('c790559c-c900-4bb1-9308-3821d549092d'::uuid, 'dfe1d689-6081-4730-9c98-6dd6dc500de5'::uuid),
    ('37e9ba69-5ea7-4fa5-b571-c75cb2076d5e'::uuid, '388715e6-1ec6-437f-b0c5-74b7037ee5e3'::uuid),
    ('6472e49c-ee6c-4cb1-860d-99c9b5ef7e21'::uuid, '8047d0c1-2e30-4f39-a4f8-f8f7802a2754'::uuid),
    ('0ed77e02-7d61-48e2-8f84-37b1820a6cd2'::uuid, 'a63c9d11-2255-450f-a699-04dcbc51d963'::uuid),
    ('7b6072d3-cbca-4633-9d3b-6dc2dc27bd98'::uuid, '21007c14-d16c-4efe-9ea4-0f6cd02fbc4d'::uuid),
    ('e3507bf6-10b0-4c79-add9-d54e96f8a814'::uuid, '80189c87-d03d-4f9b-9cc4-9afd5a72fa8b'::uuid)
       ) as v(log_id, line_id)
  join inventory_count_items i on i.id = v.line_id
 where l.id = v.log_id
   and l.source_count_item_id is null
   and l.used_by = 'Unlogged (physical count)'
   and l.reagent_id = i.reagent_id
   and i.resolved
   and i.resolution_note like 'Logged as usage%';

commit;
