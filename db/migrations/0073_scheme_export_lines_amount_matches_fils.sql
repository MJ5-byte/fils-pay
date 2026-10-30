-- scheme_export_lines.amount must be exactly amount_fils / 1000 (ADR-0002:
-- the file amount is the truncated figure). CloseBatch used to store the
-- untruncated gross, which numeric(10,2) rounded up, so the scheme file
-- overstated some lines by up to 9 fils.
--
-- NOT VALID: enforced for every new row; historical rows are left as they
-- are because they record what was actually sent to the scheme.

ALTER TABLE scheme_export_lines
    ADD CONSTRAINT chk_scheme_export_lines_amount_matches_fils
    CHECK (amount IS NULL OR amount * 1000 = amount_fils) NOT VALID;
