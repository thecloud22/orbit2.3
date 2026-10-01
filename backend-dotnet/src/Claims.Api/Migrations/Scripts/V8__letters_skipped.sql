-- V8: a letter that became moot is SKIPPED, not left queued.
-- Example: run 1 of a document workflow found a TIN mismatch and queued the W9-LIFE-01 letter, but the send failed; a re-run after the fault was gone
-- accepted the W-9, so "please correct your W-9" would be wrong. The re-run marks that letter `skipped` with a reason.
-- Nothing here rewrites a row: it widens one check and adds one nullable column. V1 to V7 are untouched.
ALTER TABLE letters DROP CONSTRAINT letters_status_ck;
ALTER TABLE letters ADD CONSTRAINT letters_status_ck CHECK (status IN ('draft', 'queued', 'sent', 'failed', 'skipped'));
ALTER TABLE letters ADD COLUMN status_reason text;
