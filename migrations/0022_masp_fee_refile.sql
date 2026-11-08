-- 2026-11-07. The shielded pool's fees the live scan filed as unshields are re-filed as kind 'masp_fee' (shared/types.ts;
-- worker/src/parse/namada.ts namFlows, the masp/fee-payment rule). A shielded transaction that pays its gas from the pool
-- moves one NAM leg out of it, to the account that paid gas, and the chain marks its inner transaction with a
-- masp/fee-payment event. Written by scripts/refile-masp-fees.ts from the stored rows and the blocks as two public nodes
-- served them (https://namada-rpc.stakeandrelax.net, https://namada-rpc.polkachu.com; a block was taken only when both gave the same token and MASP
-- events). 79 rows, 15.157321 NAM in all, each under 5 NAM; 4 rows of the same shape stay unshields (the
-- script prints each with its reason). Rows before block 7,682,174 are out of scope for this pass.
--
-- 1. The daily edges first (flow_edges_daily, migration 0007): the unshield edge of each day and receiving category
--    loses the moved rows and a masp_fee edge takes them, with the values worker/src/series.ts dayAggregates gives the
--    rows as they are stored (usd NULL when any row of the edge is unpriced). Each statement runs only while the edge's
--    first moved row is still an unshield, so the file applied twice changes nothing the second time. The stored
--    counts (flow_counts) are marked dirty by migration 0017's trigger on the kind change and written again by the
--    cron; activity_daily and masp.out_daily do not depend on these rows' kind and stay.
-- 2026-09-01 masp>user: 8 of 8 rows move; stored unshield edge n 8, 2.162507 NAM.
DELETE FROM flow_edges_daily WHERE day = '2026-09-01' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:D7A1889BD4D16FA0E9A3C59688DDA77A2B0310EF597E3A5CBE356154B0416D4A:5' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-09-01', 'namada', 'masp_fee', 'masp', 'user', 8, 2.162507, NULL WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:D7A1889BD4D16FA0E9A3C59688DDA77A2B0310EF597E3A5CBE356154B0416D4A:5' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield none left, the edge goes; masp_fee n 8, 2.162507 NAM, usd NULL
-- 2026-10-14 masp>user: 1 of 3 rows move; stored unshield edge n 3, 81000.493414 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 81000, usd = NULL WHERE day = '2026-10-14' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F77EF556382F64904BBE1EDC1BC357177D7BA1A0EE6EE2652D78288B2CE873FF:5' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-14', 'namada', 'masp_fee', 'masp', 'user', 1, 0.493414, NULL WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F77EF556382F64904BBE1EDC1BC357177D7BA1A0EE6EE2652D78288B2CE873FF:5' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 81000 NAM, usd NULL; masp_fee n 1, 0.493414 NAM, usd NULL
-- 2026-10-15 masp>user: 1 of 3 rows move; stored unshield edge n 3, 54700.893414 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 54700, usd = 47.4796 WHERE day = '2026-10-15' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:4A75C85AE82D0B1C13F2687F663BF88C6BD9640D957AE952A856AA6092518C99:6' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-15', 'namada', 'masp_fee', 'masp', 'user', 1, 0.893414, 0.000775483352 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:4A75C85AE82D0B1C13F2687F663BF88C6BD9640D957AE952A856AA6092518C99:6' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 54700 NAM, usd 47.4796; masp_fee n 1, 0.893414 NAM, usd 0.000775483352
-- 2026-10-16 masp>user: 1 of 5 rows move; stored unshield edge n 5, 60000.493414 NAM.
UPDATE flow_edges_daily SET n = 4, nam = 60000, usd = 62.83868128816798 WHERE day = '2026-10-16' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:46A6FAE296B1B779676966F816B57BACDB722E39F0F78BC5966BE3DB820B5F72:6' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-16', 'namada', 'masp_fee', 'masp', 'user', 1, 0.493414, 0.0005010249766583164 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:46A6FAE296B1B779676966F816B57BACDB722E39F0F78BC5966BE3DB820B5F72:6' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 4, 60000 NAM, usd 62.83868128816798; masp_fee n 1, 0.493414 NAM, usd 0.0005010249766583164
-- 2026-10-17 masp>user: 3 of 3 rows move; stored unshield edge n 3, 0.225 NAM.
DELETE FROM flow_edges_daily WHERE day = '2026-10-17' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:20925B043941E0E3BD39D0CD034DA901F4083F8CD367C31DF6F2F0A5F4EFFAC0:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-17', 'namada', 'masp_fee', 'masp', 'user', 3, 0.225, 0.00022904786567098047 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:20925B043941E0E3BD39D0CD034DA901F4083F8CD367C31DF6F2F0A5F4EFFAC0:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield none left, the edge goes; masp_fee n 3, 0.225 NAM, usd 0.00022904786567098047
-- 2026-10-18 masp>user: 3 of 4 rows move; stored unshield edge n 4, 60000.2325 NAM.
UPDATE flow_edges_daily SET n = 1, nam = 60000, usd = 63.72363650648855 WHERE day = '2026-10-18' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:8ABE4A300C44B277FA3EAE17B2E7CCBF2BD8DFC3F348D4ECDA5965F4426C17C5:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-18', 'namada', 'masp_fee', 'masp', 'user', 3, 0.2325, 0.0002612543612921682 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:8ABE4A300C44B277FA3EAE17B2E7CCBF2BD8DFC3F348D4ECDA5965F4426C17C5:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 1, 60000 NAM, usd 63.72363650648855; masp_fee n 3, 0.2325 NAM, usd 0.0002612543612921682
-- 2026-10-19 masp>user: 9 of 11 rows move; stored unshield edge n 11, 60002.828656 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 60000, usd = 71.85131113824582 WHERE day = '2026-10-19' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:AAD6D6BBB2BD7781FA442D8C7DA0B90E0A12120F234133A5177223ACFA981DAC:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-19', 'namada', 'masp_fee', 'masp', 'user', 9, 2.828656, 0.003792848552117755 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:AAD6D6BBB2BD7781FA442D8C7DA0B90E0A12120F234133A5177223ACFA981DAC:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 60000 NAM, usd 71.85131113824582; masp_fee n 9, 2.828656 NAM, usd 0.003792848552117755
-- 2026-10-20 masp>user: 5 of 6 rows move; stored unshield edge n 6, 35000.445 NAM.
UPDATE flow_edges_daily SET n = 1, nam = 35000, usd = 41.14080360325334 WHERE day = '2026-10-20' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9DC5A0CB9CD6AB6B74E314B84CB06FFB027F9622C0573C866B0BBA541CCCC1AD:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-20', 'namada', 'masp_fee', 'masp', 'user', 5, 0.445, 0.000513441575658779 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9DC5A0CB9CD6AB6B74E314B84CB06FFB027F9622C0573C866B0BBA541CCCC1AD:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 1, 35000 NAM, usd 41.14080360325334; masp_fee n 5, 0.445 NAM, usd 0.000513441575658779
-- 2026-10-21 masp>user: 1 of 6 rows move; stored unshield edge n 6, 1736000.095 NAM.
UPDATE flow_edges_daily SET n = 5, nam = 1736000, usd = 1969.9461053833336 WHERE day = '2026-10-21' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:981234156B7E501B53956EB48CC3707680AF8C2B0A7F2F1B05396620993F078C:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-21', 'namada', 'masp_fee', 'masp', 'user', 1, 0.095, 0.00007782505060214079 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:981234156B7E501B53956EB48CC3707680AF8C2B0A7F2F1B05396620993F078C:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 5, 1736000 NAM, usd 1969.9461053833336; masp_fee n 1, 0.095 NAM, usd 0.00007782505060214079
-- 2026-10-22 masp>user: 3 of 6 rows move; stored unshield edge n 6, 24003.0341 NAM.
UPDATE flow_edges_daily SET n = 3, nam = 24002.7591, usd = 20.296104943902982 WHERE day = '2026-10-22' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:C0DAE4076EC3852DDA27F95558FD7AA1E72D21891FBBBF136D5ED74346445A39:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-22', 'namada', 'masp_fee', 'masp', 'user', 3, 0.275, 0.00023380156315010696 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:C0DAE4076EC3852DDA27F95558FD7AA1E72D21891FBBBF136D5ED74346445A39:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 3, 24002.7591 NAM, usd 20.296104943902982; masp_fee n 3, 0.275 NAM, usd 0.00023380156315010696
-- 2026-10-23 masp>user: 6 of 8 rows move; stored unshield edge n 8, 90000.54 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 90000, usd = 78.62315703789528 WHERE day = '2026-10-23' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:CDCC6E07505CEE110112219BFA77FD77E20DDED2D842AA31E8C4210F8AFD6F0E:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-23', 'namada', 'masp_fee', 'masp', 'user', 6, 0.54, 0.0004871609749937041 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:CDCC6E07505CEE110112219BFA77FD77E20DDED2D842AA31E8C4210F8AFD6F0E:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 90000 NAM, usd 78.62315703789528; masp_fee n 6, 0.54 NAM, usd 0.0004871609749937041
-- 2026-10-24 masp>user: 14 of 16 rows move; stored unshield edge n 16, 100001.7875 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 100000, usd = NULL WHERE day = '2026-10-24' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:605D049FD39209283D50CCF8E4172EFED98630DD57FEC1A34403BB6E3FE3F186:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-24', 'namada', 'masp_fee', 'masp', 'user', 14, 1.7875, NULL WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:605D049FD39209283D50CCF8E4172EFED98630DD57FEC1A34403BB6E3FE3F186:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 100000 NAM, usd NULL; masp_fee n 14, 1.7875 NAM, usd NULL
-- 2026-10-25 masp>user: 3 of 6 rows move; stored unshield edge n 6, 434000.355 NAM.
UPDATE flow_edges_daily SET n = 3, nam = 434000, usd = 416.86213448176034 WHERE day = '2026-10-25' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9B3D601CE83B426AFAC46E2B9F055D24671D6593429D8EC7A5B5BA09BA35256D:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-25', 'namada', 'masp_fee', 'masp', 'user', 3, 0.355, 0.0003191051617376633 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9B3D601CE83B426AFAC46E2B9F055D24671D6593429D8EC7A5B5BA09BA35256D:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 3, 434000 NAM, usd 416.86213448176034; masp_fee n 3, 0.355 NAM, usd 0.0003191051617376633
-- 2026-10-27 masp>user: 2 of 5 rows move; stored unshield edge n 5, 70006.975012 NAM.
UPDATE flow_edges_daily SET n = 3, nam = 70006.250011, usd = 47.94260274590878 WHERE day = '2026-10-27' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:2AFD153AA3C7886152550E5CD08A17C68D4A9E4FD6BD0296DDA16E25E2F6BC55:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-27', 'namada', 'masp_fee', 'masp', 'user', 2, 0.725001, 0.0006348905282775303 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:2AFD153AA3C7886152550E5CD08A17C68D4A9E4FD6BD0296DDA16E25E2F6BC55:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 3, 70006.250011 NAM, usd 47.94260274590878; masp_fee n 2, 0.725001 NAM, usd 0.0006348905282775303
-- 2026-10-28 masp>user: 3 of 3 rows move; stored unshield edge n 3, 0.5 NAM.
DELETE FROM flow_edges_daily WHERE day = '2026-10-28' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:B01FF4F14ED70F37AE101FB926D92F485DB1F7BB8BDE0E5D4ED213EABC7E3A12:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-28', 'namada', 'masp_fee', 'masp', 'user', 3, 0.5, 0.0004844486586123943 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:B01FF4F14ED70F37AE101FB926D92F485DB1F7BB8BDE0E5D4ED213EABC7E3A12:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield none left, the edge goes; masp_fee n 3, 0.5 NAM, usd 0.0004844486586123943
-- 2026-10-29 masp>user: 2 of 3 rows move; stored unshield edge n 3, 800000.3375 NAM.
UPDATE flow_edges_daily SET n = 1, nam = 800000, usd = 860.8535768109305 WHERE day = '2026-10-29' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9233F12C4FAD0723D3D3ED147274923A7F83AD4B6E00EAA7D8D33CFFA3BC8E90:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-29', 'namada', 'masp_fee', 'masp', 'user', 2, 0.3375, 0.00032183771397949185 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:9233F12C4FAD0723D3D3ED147274923A7F83AD4B6E00EAA7D8D33CFFA3BC8E90:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 1, 800000 NAM, usd 860.8535768109305; masp_fee n 2, 0.3375 NAM, usd 0.00032183771397949185
-- 2026-10-30 masp>user: 2 of 4 rows move; stored unshield edge n 4, 390000.868414 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 390000, usd = 320.92074850102097 WHERE day = '2026-10-30' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F910860C2EE4055D5BE04F22FB39DD5ECD402C256101EF4459C3B2679D135E17:5' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-30', 'namada', 'masp_fee', 'masp', 'user', 2, 0.868414, 0.0007246729769902089 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F910860C2EE4055D5BE04F22FB39DD5ECD402C256101EF4459C3B2679D135E17:5' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 390000 NAM, usd 320.92074850102097; masp_fee n 2, 0.868414 NAM, usd 0.0007246729769902089
-- 2026-10-31 masp>user: 1 of 1 rows move; stored unshield edge n 1, 0.175 NAM.
DELETE FROM flow_edges_daily WHERE day = '2026-10-31' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F873E84A9406E46113284625B92AF79AA2F19BDBD4495FC69DA6DD22F439621D:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-10-31', 'namada', 'masp_fee', 'masp', 'user', 1, 0.175, 0.00013351015635763906 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:F873E84A9406E46113284625B92AF79AA2F19BDBD4495FC69DA6DD22F439621D:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield none left, the edge goes; masp_fee n 1, 0.175 NAM, usd 0.00013351015635763906
-- 2026-11-01 masp>user: 5 of 7 rows move; stored unshield edge n 7, 2040000.815 NAM.
UPDATE flow_edges_daily SET n = 2, nam = 2040000, usd = 1555.9120687181503 WHERE day = '2026-11-01' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:436017A9E8B621F9C9CB592B6DC3A466A364539F3C3FCFA3780776154425AD09:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-11-01', 'namada', 'masp_fee', 'masp', 'user', 5, 0.815, 0.000622170268747636 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:436017A9E8B621F9C9CB592B6DC3A466A364539F3C3FCFA3780776154425AD09:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 2, 2040000 NAM, usd 1555.9120687181503; masp_fee n 5, 0.815 NAM, usd 0.000622170268747636
-- 2026-11-02 masp>user: 6 of 10 rows move; stored unshield edge n 10, 19550099.910001 NAM.
UPDATE flow_edges_daily SET n = 4, nam = 19550099, usd = 13298.724662531384 WHERE day = '2026-11-02' AND chain = 'namada' AND kind = 'unshield' AND from_cat = 'masp' AND to_cat = 'user' AND EXISTS (SELECT 1 FROM flows WHERE id = 'namada:77BFAC2578362FA7F8FF08CCAFB4CB52C55B42F67C7E7B555059CA00E402A3BB:1' AND kind = 'unshield');
INSERT INTO flow_edges_daily (day, chain, kind, from_cat, to_cat, n, nam, usd) SELECT '2026-11-02', 'namada', 'masp_fee', 'masp', 'user', 6, 0.910001, 0.0006525980094571709 WHERE EXISTS (SELECT 1 FROM flows WHERE id = 'namada:77BFAC2578362FA7F8FF08CCAFB4CB52C55B42F67C7E7B555059CA00E402A3BB:1' AND kind = 'unshield') ON CONFLICT (chain, kind, from_cat, to_cat, day) DO UPDATE SET n = n + excluded.n, nam = nam + excluded.nam, usd = CASE WHEN flow_edges_daily.usd IS NULL OR excluded.usd IS NULL THEN NULL ELSE flow_edges_daily.usd + excluded.usd END;
--    unshield n 4, 19550099 NAM, usd 13298.724662531384; masp_fee n 6, 0.910001 NAM, usd 0.0006525980094571709
--
-- 2. The rows. Each changes only while it is still an unshield.
-- block 7,901,354, 0.136453 NAM, indexed-tx {"block_height":7901354,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:B01C5E287A25C4E3EEE4602E65984C3BA041B64AC9D47F56C0AE623273C7CCB3:5' AND kind = 'unshield';
-- block 7,901,472, 0.136453 NAM, indexed-tx {"block_height":7901472,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:BF36864E8D671BCD87230CB567394C76CA98EDAB640026AF952C1F8B86CD468D:5' AND kind = 'unshield';
-- block 7,901,492, 0.136453 NAM, indexed-tx {"block_height":7901492,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:2A6EA78AB840CE5A85AA34431F1AB903F47DC3D02996D88E111ECB9E8FEC0C28:5' AND kind = 'unshield';
-- block 7,901,508, 0.136453 NAM, indexed-tx {"block_height":7901508,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:DC17C36676CAB028FE149E43F080DA8D4959F98F8325719E1F5233269442416E:5' AND kind = 'unshield';
-- block 7,903,391, 0.136453 NAM, indexed-tx {"block_height":7903391,"block_index":1,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:EF418983C5C73779B5994FB803F127B545C8990661D3398AB40243914551A66E:5' AND kind = 'unshield';
-- block 7,904,192, 0.493414 NAM, indexed-tx {"block_height":7904192,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:809CFD1E129AEF59EB3EC48A35C59C8B1AAB94362AA460781CEBF90B7041A407:5' AND kind = 'unshield';
-- block 7,904,212, 0.493414 NAM, indexed-tx {"block_height":7904212,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:E6638660EC0A42C57B91BC67341B968463FCAA2976A34B93B6E31EBD435F2E6A:5' AND kind = 'unshield';
-- block 7,904,251, 0.493414 NAM, indexed-tx {"block_height":7904251,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:D7A1889BD4D16FA0E9A3C59688DDA77A2B0310EF597E3A5CBE356154B0416D4A:5' AND kind = 'unshield';
-- block 8,274,814, 0.493414 NAM, indexed-tx {"block_height":8274814,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F77EF556382F64904BBE1EDC1BC357177D7BA1A0EE6EE2652D78288B2CE873FF:5' AND kind = 'unshield';
-- block 8,290,188, 0.893414 NAM, indexed-tx {"block_height":8290188,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:4A75C85AE82D0B1C13F2687F663BF88C6BD9640D957AE952A856AA6092518C99:6' AND kind = 'unshield';
-- block 8,295,532, 0.493414 NAM, indexed-tx {"block_height":8295532,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:46A6FAE296B1B779676966F816B57BACDB722E39F0F78BC5966BE3DB820B5F72:6' AND kind = 'unshield';
-- block 8,308,627, 0.075 NAM, indexed-tx {"block_height":8308627,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:94C03D90808415FF458B3EDDB7EE2C569CD18642599F81B7DE4D2AF203C8AE1F:1' AND kind = 'unshield';
-- block 8,310,956, 0.075 NAM, indexed-tx {"block_height":8310956,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:065714794E36081FB074005B3B259F1A9FC6AD2A0C1E58D8068333F58BC819CB:1' AND kind = 'unshield';
-- block 8,315,272, 0.075 NAM, indexed-tx {"block_height":8315272,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:20925B043941E0E3BD39D0CD034DA901F4083F8CD367C31DF6F2F0A5F4EFFAC0:1' AND kind = 'unshield';
-- block 8,321,300, 0.0625 NAM, indexed-tx {"block_height":8321300,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:688D73B3A80E07533448D1DF0CD7F011018863F0037FBDD1E5D03AC0D95D25FD:1' AND kind = 'unshield';
-- block 8,321,554, 0.075 NAM, indexed-tx {"block_height":8321554,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:0BBF132F1C7275371AF585B03FDD1B28725908A44DAE430E4C62E06C057F7F02:1' AND kind = 'unshield';
-- block 8,325,777, 0.095 NAM, indexed-tx {"block_height":8325777,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:8ABE4A300C44B277FA3EAE17B2E7CCBF2BD8DFC3F348D4ECDA5965F4426C17C5:1' AND kind = 'unshield';
-- block 8,334,684, 0.693414 NAM, indexed-tx {"block_height":8334684,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:08A3F04A00D348882339C57BFB56D0E78889110FBA0977D91AD28AFD48EAE383:6' AND kind = 'unshield';
-- block 8,334,804, 0.085 NAM, indexed-tx {"block_height":8334804,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:C61DB959199B0602BB51ACA82D13086BC6E077BD62A2950A8F8D709D613C794A:1' AND kind = 'unshield';
-- block 8,334,852, 0.085 NAM, indexed-tx {"block_height":8334852,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:1E615230051BE907F05F847C72F0269E6102726739D379E9FB688837456E14DC:1' AND kind = 'unshield';
-- block 8,334,909, 0.593414 NAM, indexed-tx {"block_height":8334909,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:06C35FEB2B973623F980E8DAB118EC97688EF4F2B8D4BF268399AFFCF83CEA83:6' AND kind = 'unshield';
-- block 8,335,411, 0.095 NAM, indexed-tx {"block_height":8335411,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:22715CC913F436DAAC0ABF55AAF060862ED6382929F4E253C2845ECDD341E05F:1' AND kind = 'unshield';
-- block 8,335,647, 0.593414 NAM, indexed-tx {"block_height":8335647,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:6FDE922B2CBAECDA4236559855DE15E336C5D75A94864C4AFDA12212BDECF8A7:6' AND kind = 'unshield';
-- block 8,335,982, 0.095 NAM, indexed-tx {"block_height":8335982,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:130EA3F2CBDDBA05CA597708CE675305E0EFE4C9D6D6A2714507E0CE382AA6DD:1' AND kind = 'unshield';
-- block 8,340,626, 0.493414 NAM, indexed-tx {"block_height":8340626,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:06B18C4A5FE43CBA9594FA0AA0D6A8C1ADD82D634B2890C2765A29352C4CA44C:6' AND kind = 'unshield';
-- block 8,340,663, 0.095 NAM, indexed-tx {"block_height":8340663,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:AAD6D6BBB2BD7781FA442D8C7DA0B90E0A12120F234133A5177223ACFA981DAC:1' AND kind = 'unshield';
-- block 8,345,942, 0.095 NAM, indexed-tx {"block_height":8345942,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:3B982D70A92E3C36C88B2919BC6E082559D97B451FB8654D70A7F729917AB277:1' AND kind = 'unshield';
-- block 8,347,720, 0.095 NAM, indexed-tx {"block_height":8347720,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:4DF32D80C2F2F289F823EA450F461937DF02236A1DAD818B0FBAD04AB13F3DED:1' AND kind = 'unshield';
-- block 8,348,895, 0.095 NAM, indexed-tx {"block_height":8348895,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:09C30DD85D1CE3AB45E3F8549ACF428CAC0A3A083AFA88FAFD1D5A603168C477:1' AND kind = 'unshield';
-- block 8,352,610, 0.085 NAM, indexed-tx {"block_height":8352610,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:E784FFA145BDCCB0F48CB0487ABAB3BF48E4B28722345D28E764CEBDDB3E32DA:1' AND kind = 'unshield';
-- block 8,353,773, 0.075 NAM, indexed-tx {"block_height":8353773,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:9DC5A0CB9CD6AB6B74E314B84CB06FFB027F9622C0573C866B0BBA541CCCC1AD:1' AND kind = 'unshield';
-- block 8,366,300, 0.095 NAM, indexed-tx {"block_height":8366300,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:981234156B7E501B53956EB48CC3707680AF8C2B0A7F2F1B05396620993F078C:1' AND kind = 'unshield';
-- block 8,372,960, 0.095 NAM, indexed-tx {"block_height":8372960,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F22E575471CFAFA1E559B7ACF353EC4ED4A631FDB8D1B3D156CE2932B084494A:1' AND kind = 'unshield';
-- block 8,374,498, 0.085 NAM, indexed-tx {"block_height":8374498,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:50DF3381A8E9B1FF99A3E3DAF25B1A5898557759A345242FB276E53CE074174A:1' AND kind = 'unshield';
-- block 8,378,693, 0.095 NAM, indexed-tx {"block_height":8378693,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:C0DAE4076EC3852DDA27F95558FD7AA1E72D21891FBBBF136D5ED74346445A39:1' AND kind = 'unshield';
-- block 8,387,903, 0.095 NAM, indexed-tx {"block_height":8387903,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:293A916373D77B770A77193419C5A10E5E26A383FF828E3323CADA443B5400F5:1' AND kind = 'unshield';
-- block 8,387,964, 0.085 NAM, indexed-tx {"block_height":8387964,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:159763CD7A47555844617E66CD746F10510F0454687504766428AFB35DFF70EA:1' AND kind = 'unshield';
-- block 8,389,608, 0.085 NAM, indexed-tx {"block_height":8389608,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:43E7E6A378E1CD07AA4CF98809C0A3462918A0D32BB7D9AE48E61F4258E77385:1' AND kind = 'unshield';
-- block 8,389,803, 0.085 NAM, indexed-tx {"block_height":8389803,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:1AB87F6EBA666CDFBF95F327BDB6730B05762EBC1C9E088233CE0C5AAE6DC526:1' AND kind = 'unshield';
-- block 8,390,582, 0.1 NAM, indexed-tx {"block_height":8390582,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:498E94E73D27FE425D3438F14DC48D0A876D1FEF60E3A6E1AAD601E4996EA320:1' AND kind = 'unshield';
-- block 8,390,665, 0.09 NAM, indexed-tx {"block_height":8390665,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:CDCC6E07505CEE110112219BFA77FD77E20DDED2D842AA31E8C4210F8AFD6F0E:1' AND kind = 'unshield';
-- block 8,397,271, 0.0925 NAM, indexed-tx {"block_height":8397271,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:3B5D54647B4259004C91D1AC4F226FE6EDC6ABD65F59FDB4589FD50E2874805D:1' AND kind = 'unshield';
-- block 8,397,553, 0.085 NAM, indexed-tx {"block_height":8397553,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:D639A3DF25FA8B735E2FF0ECB50F77346C6163C978CBAFEB779DBC18AA54D624:1' AND kind = 'unshield';
-- block 8,397,615, 0.075 NAM, indexed-tx {"block_height":8397615,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:5F45929354F1A666F82C0ECBFD685783CB85A5FFD57276B5E15DCF90A4C8A5BF:1' AND kind = 'unshield';
-- block 8,397,823, 0.4 NAM, indexed-tx {"block_height":8397823,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:8F3BD595F6953E6981508EC92CBDC2F313E7842DE6EFCD897BEDB9F71B3C8798:1' AND kind = 'unshield';
-- block 8,397,914, 0.0625 NAM, indexed-tx {"block_height":8397914,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F901094074F448E7565D97920FCE86FAE084C14F50B8995B027EA16A7DFDC1DB:1' AND kind = 'unshield';
-- block 8,397,956, 0.12 NAM, indexed-tx {"block_height":8397956,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:E26E46C5C861868D9710AFED2360CBD4D22E9302692B56CEDA38AF5B18B76671:1' AND kind = 'unshield';
-- block 8,398,034, 0.075 NAM, indexed-tx {"block_height":8398034,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:B75AB520F6934177F960ED8B977A8365D45D279E215397C8E0823779A3F90BFF:1' AND kind = 'unshield';
-- block 8,398,086, 0.0625 NAM, indexed-tx {"block_height":8398086,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:6D8E33A6395AD451785F799FD5F08D2EC633A9EA75C55D706FAE7290F439EDFF:1' AND kind = 'unshield';
-- block 8,398,114, 0.075 NAM, indexed-tx {"block_height":8398114,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:11789BD5187585E4F5D8E2BE14C776415F6A4FA05020D9378311165F2EE17159:1' AND kind = 'unshield';
-- block 8,398,128, 0.075 NAM, indexed-tx {"block_height":8398128,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:3A2B39600416BAE0BD422A5EBFD56BD3900C944D8DC5D14581EE701124FE749C:1' AND kind = 'unshield';
-- block 8,398,198, 0.2 NAM, indexed-tx {"block_height":8398198,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:E2F12B12B3AD49B661FDBF483D6BA689DACC8157C0BDA4BAC5EBC81643C14D63:1' AND kind = 'unshield';
-- block 8,398,237, 0.205 NAM, indexed-tx {"block_height":8398237,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:7A0CAB125EE7FB7FDBE336D230406250A13A8C7C27EBCBEA3E175292EC050D39:1' AND kind = 'unshield';
-- block 8,398,254, 0.175 NAM, indexed-tx {"block_height":8398254,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:EFD81F1CFC8B5EF0F011EC3A00ABB6A8D836CDB16B96AEA03A80DAABCB10C7A1:1' AND kind = 'unshield';
-- block 8,401,001, 0.085 NAM, indexed-tx {"block_height":8401001,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:605D049FD39209283D50CCF8E4172EFED98630DD57FEC1A34403BB6E3FE3F186:1' AND kind = 'unshield';
-- block 8,409,405, 0.095 NAM, indexed-tx {"block_height":8409405,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:06150EB0B9C3085DDAE0F7748E369BEDC2E5D52ABC8FA239F159FBFC727513F5:1' AND kind = 'unshield';
-- block 8,415,322, 0.085 NAM, indexed-tx {"block_height":8415322,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:ADE695C97F943E4F017C17CFBCB9BC1B6B5969CD9EB05EFD7A439A58A52A19F3:1' AND kind = 'unshield';
-- block 8,416,278, 0.175 NAM, indexed-tx {"block_height":8416278,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:9B3D601CE83B426AFAC46E2B9F055D24671D6593429D8EC7A5B5BA09BA35256D:1' AND kind = 'unshield';
-- block 8,433,916, 0.625001 NAM, indexed-tx {"block_height":8433916,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:CACEBB004C4283167BE64F2E15EBE7CE887E9BACA201C6AD174504D351849C9C:1' AND kind = 'unshield';
-- block 8,433,939, 0.1 NAM, indexed-tx {"block_height":8433939,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:2AFD153AA3C7886152550E5CD08A17C68D4A9E4FD6BD0296DDA16E25E2F6BC55:1' AND kind = 'unshield';
-- block 8,446,292, 0.1625 NAM, indexed-tx {"block_height":8446292,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:BC2C6E7EDFD75B6E41E67A53C4517996CE57F7FD1C4580D46D14DDC1E8EEC491:1' AND kind = 'unshield';
-- block 8,448,543, 0.1625 NAM, indexed-tx {"block_height":8448543,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:E6463BF9366D253B8A26BC7E626999168C8BD084CBEE349A974C6EC61E3DD559:1' AND kind = 'unshield';
-- block 8,449,000, 0.175 NAM, indexed-tx {"block_height":8449000,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:B01FF4F14ED70F37AE101FB926D92F485DB1F7BB8BDE0E5D4ED213EABC7E3A12:1' AND kind = 'unshield';
-- block 8,458,535, 0.1625 NAM, indexed-tx {"block_height":8458535,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:DAFBBDF558EBEF4D94804C8DE5717F80A18767C975F31BF9BD16721938FEF99A:1' AND kind = 'unshield';
-- block 8,466,675, 0.175 NAM, indexed-tx {"block_height":8466675,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:9233F12C4FAD0723D3D3ED147274923A7F83AD4B6E00EAA7D8D33CFFA3BC8E90:1' AND kind = 'unshield';
-- block 8,475,506, 0.175 NAM, indexed-tx {"block_height":8475506,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:0021354539C641313BBEC8167C8CBDCD653D2E029D183E823D8AFDA3947F378B:1' AND kind = 'unshield';
-- block 8,479,569, 0.693414 NAM, indexed-tx {"block_height":8479569,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F910860C2EE4055D5BE04F22FB39DD5ECD402C256101EF4459C3B2679D135E17:5' AND kind = 'unshield';
-- block 8,490,950, 0.175 NAM, indexed-tx {"block_height":8490950,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F873E84A9406E46113284625B92AF79AA2F19BDBD4495FC69DA6DD22F439621D:1' AND kind = 'unshield';
-- block 8,497,390, 0.155 NAM, indexed-tx {"block_height":8497390,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:027A6022C4CD16B2F3C1B207AEE6691BF72AB4B2A0C94C89232D37F759D5E068:1' AND kind = 'unshield';
-- block 8,499,206, 0.175 NAM, indexed-tx {"block_height":8499206,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:9C831FF08CA41B83675EC00BB6DDF60298E5F51F11313A707F7552537AD5CF50:1' AND kind = 'unshield';
-- block 8,499,446, 0.1625 NAM, indexed-tx {"block_height":8499446,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:45712CD1D45121801B313E7B56C1943FF4F0397605481959D5138851E7B24BA6:1' AND kind = 'unshield';
-- block 8,499,764, 0.16 NAM, indexed-tx {"block_height":8499764,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:5D5E00E6C2818A1FC4975A5DFC0BE1FD0D72DB1185F65D79A647CAD240DEED31:1' AND kind = 'unshield';
-- block 8,505,007, 0.1625 NAM, indexed-tx {"block_height":8505007,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:436017A9E8B621F9C9CB592B6DC3A466A364539F3C3FCFA3780776154425AD09:1' AND kind = 'unshield';
-- block 8,513,086, 0.1625 NAM, indexed-tx {"block_height":8513086,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:A5E946C5D2D24AC3640ACFE73A187E8282B3979942C9104DCD70899118DD7A40:1' AND kind = 'unshield';
-- block 8,513,155, 0.0925 NAM, indexed-tx {"block_height":8513155,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:88833CF75C435A995B465ADC67FCDD174DF00E56F1C7C5CD9BC220234138131A:1' AND kind = 'unshield';
-- block 8,515,196, 0.1625 NAM, indexed-tx {"block_height":8515196,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:AD4DB9CD834867CBC65D21B06B253D864A3EB8154EC60B08E552A9D3A8943703:1' AND kind = 'unshield';
-- block 8,515,250, 0.175 NAM, indexed-tx {"block_height":8515250,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:6C67558472A9EF53484E30899B36D2F65213403E0A7B4F970017278FFB2B60FA:1' AND kind = 'unshield';
-- block 8,516,752, 0.155001 NAM, indexed-tx {"block_height":8516752,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:F30621AC8A2FBE5E57C4CD036AD8949AFDD7073BAD90727B00D759F011691A69:1' AND kind = 'unshield';
-- block 8,517,143, 0.1625 NAM, indexed-tx {"block_height":8517143,"block_index":0,"batch_index":0}; the same events from https://namada-rpc.stakeandrelax.net and https://namada-rpc.polkachu.com
UPDATE flows SET kind = 'masp_fee' WHERE id = 'namada:77BFAC2578362FA7F8FF08CCAFB4CB52C55B42F67C7E7B555059CA00E402A3BB:1' AND kind = 'unshield';
--
-- Check after applying: 79 rows of kind 'masp_fee' among these ids, none of them an unshield; the edges of one day as
-- written above; the stored counts dirty until the cron's next write.
--   SELECT kind, COUNT(*) FROM flows WHERE id IN ('namada:B01C5E287A25C4E3EEE4602E65984C3BA041B64AC9D47F56C0AE623273C7CCB3:5', 'namada:BF36864E8D671BCD87230CB567394C76CA98EDAB640026AF952C1F8B86CD468D:5', 'namada:2A6EA78AB840CE5A85AA34431F1AB903F47DC3D02996D88E111ECB9E8FEC0C28:5', …) GROUP BY kind;
--   SELECT kind, to_cat, n, nam, usd FROM flow_edges_daily WHERE day = '2026-09-01' AND chain = 'namada' AND kind IN ('unshield', 'masp_fee');
--   SELECT dirty FROM flow_count_mark WHERE id = 1;
