-- Seed: SAF-T standard tax codes (vat_code) and their dated rates (vat_rate).
--
-- Provenance
--   Codes and English/Norwegian wording: Skatteetaten/saf-t
--   "Standard Tax Codes/CSV/Standard_Tax_Codes.csv", commit 07bb616 (2021-04-14),
--   fetched 2026-10-10. Norwegian texts follow enkelt-regnskap core/mva.ts style
--   ("mva", rate qualifier appended) so the official base text stays unique per code.
--   Regime semantics: fikencore vat.go (line VAT / basis / direct / zero) and
--   ~/hvelv/repos/hovedbok/research-norsk-compliance.md.
--   report = valid mvaKode in MVA-meldingen (Skatteetaten/mva-meldingen
--   informasjonsmodell: 1 3 5 6 11-15 31-33 51 52 81-89 91 92). 0, 7, 20, 21, 22
--   are bookkeeping-only codes and never reach the return.
--
-- Semantics of the columns (see 0002)
--   kind        how the code aggregates in the MVA return
--     none            no VAT treatment (0, 20) and cost-of-import basis lines (21, 22)
--     input           domestic input VAT (1, 11-13)
--     import_input    input VAT paid at the border, the amount itself (14, 15)
--     output          domestic output VAT (3, 31-33)
--     zero            zero-rated turnover inside the VAT Act; base is reported (5, 51, 52)
--     outside         turnover outside the VAT Act; base is reported (6)
--     no_turnover     income that is not turnover under the VAT Act (7)
--     import_base     base on import of goods under deferred settlement (81-85):
--                     one base line, BOTH output VAT and (if deductible) input VAT
--     reverse_charge  services from abroad / domestic emission allowances and gold
--                     (86-89, 91, 92): one base line, BOTH output VAT and (if
--                     deductible) input VAT
--   deductible  true only where the code produces input VAT the entity may deduct
--   report      the code appears in the MVA-melding
--
-- Rates
--   Rateless and zero-rated codes: 0 from 1970-01-01 (0002 convention).
--   Rated codes: today's rates from 2022-01-01, when MVA-meldingen moved onto the
--   SAF-T codes; every rate below has held unchanged since 2021-10-01 (low rate
--   back to 12 % after the 2020-04-01..2021-09-30 6 % period). Neither taxonomy
--   reference carries earlier history, so none is seeded: a rated code on a
--   posting before 2022 is refused by check_posting(), which is the safe failure.
--   A future rate change is a new vat_rate row with its valid_from, never an update.

insert into vat_code (code, kind, deductible, report, description_nb, description) values
  -- no VAT treatment
  ('0',  'none',           false, false, 'Ingen merverdiavgiftsbehandling (anskaffelser)',
                                         'No VAT treatment (purchases)'),
  ('7',  'no_turnover',    false, false, 'Ingen merverdiavgiftsbehandling (inntekter)',
                                         'No VAT treatment - no turnover according to the VAT legislation'),
  -- domestic input VAT
  ('1',  'input',          true,  true,  'Fradragsberettiget innenlands inngående mva, alminnelig sats',
                                         'Input VAT deductible (domestic), regular rate'),
  ('11', 'input',          true,  true,  'Fradragsberettiget innenlands inngående mva, middels sats',
                                         'Input VAT deductible (domestic), reduced rate, middle'),
  ('12', 'input',          true,  true,  'Fradragsberettiget innenlands inngående mva, råfisksats',
                                         'Input VAT deductible (domestic), reduced rate, raw fish'),
  ('13', 'input',          true,  true,  'Fradragsberettiget innenlands inngående mva, lav sats',
                                         'Input VAT deductible (domestic), reduced rate, low'),
  -- input VAT paid on import (the amount itself, no base)
  ('14', 'import_input',   true,  true,  'Fradragsberettiget innførselsmva, alminnelig sats',
                                         'Input VAT deductible (paid on import), regular rate'),
  ('15', 'import_input',   true,  true,  'Fradragsberettiget innførselsmva, middels sats',
                                         'Input VAT deductible (paid on import), reduced rate, middle'),
  -- cost of imported goods (bookkeeping only)
  ('20', 'none',           false, false, 'Kostnad ved innførsel av varer, ingen mva-behandling',
                                         'No VAT treatment (cost of imported goods)'),
  ('21', 'none',           false, false, 'Kostnad ved innførsel av varer, alminnelig sats',
                                         'Basis on import of goods, regular rate'),
  ('22', 'none',           false, false, 'Kostnad ved innførsel av varer, middels sats',
                                         'Basis on import of goods, reduced rate, middle'),
  -- domestic output VAT
  ('3',  'output',         false, true,  'Utgående mva, alminnelig sats',
                                         'Output VAT, regular rate'),
  ('31', 'output',         false, true,  'Utgående mva, middels sats',
                                         'Output VAT, reduced rate, middle'),
  ('32', 'output',         false, true,  'Utgående mva, råfisksats',
                                         'Output VAT, reduced rate, raw fish'),
  ('33', 'output',         false, true,  'Utgående mva, lav sats',
                                         'Output VAT, reduced rate, low'),
  -- zero rate (inside the VAT Act)
  ('5',  'zero',           false, true,  'Innenlands omsetning og uttak fritatt for mva, 0 %',
                                         'No output VAT, zero rate'),
  ('51', 'zero',           false, true,  'Innenlands omsetning med omvendt avgiftsplikt, 0 %',
                                         'Domestic sales with reverse charge, zero rate'),
  ('52', 'zero',           false, true,  'Utførsel av varer og tjenester, 0 %',
                                         'Export of goods and services, zero rate'),
  -- outside the VAT Act
  ('6',  'outside',        false, true,  'Omsetning og uttak utenfor merverdiavgiftsloven',
                                         'Turnover and withdrawals outside the scope of the VAT legislation'),
  -- import of goods, deferred settlement: both effects from one base line
  ('81', 'import_base',    true,  true,  'Grunnlag innførsel av varer med fradragsrett for innførselsmva, alminnelig sats',
                                         'Importation of goods, VAT deductible, regular rate'),
  ('82', 'import_base',    false, true,  'Grunnlag innførsel av varer uten fradragsrett for innførselsmva, alminnelig sats',
                                         'Importation of goods, without deduction of VAT, regular rate'),
  ('83', 'import_base',    true,  true,  'Grunnlag innførsel av varer med fradragsrett for innførselsmva, middels sats',
                                         'Importation of goods, VAT deductible, reduced rate, middle'),
  ('84', 'import_base',    false, true,  'Grunnlag innførsel av varer uten fradragsrett for innførselsmva, middels sats',
                                         'Importation of goods, without deduction of VAT, reduced rate, middle'),
  ('85', 'import_base',    false, true,  'Grunnlag innførsel av varer som det ikke skal beregnes mva av, 0 %',
                                         'Importation of goods, not applicable for VAT, zero rate'),
  -- reverse charge: both effects from one base line
  ('86', 'reverse_charge', true,  true,  'Tjenester kjøpt fra utlandet med fradragsrett for mva, alminnelig sats',
                                         'Services purchased from abroad, VAT deductible, regular rate'),
  ('87', 'reverse_charge', false, true,  'Tjenester kjøpt fra utlandet uten fradragsrett for mva, alminnelig sats',
                                         'Services purchased from abroad, without deduction of VAT, regular rate'),
  ('88', 'reverse_charge', true,  true,  'Tjenester kjøpt fra utlandet med fradragsrett for mva, lav sats',
                                         'Services purchased from abroad, VAT deductible, reduced rate, low'),
  ('89', 'reverse_charge', false, true,  'Tjenester kjøpt fra utlandet uten fradragsrett for mva, lav sats',
                                         'Services purchased from abroad, without deduction of VAT, reduced rate, low'),
  ('91', 'reverse_charge', true,  true,  'Kjøp av klimakvoter eller gull med fradragsrett for mva, alminnelig sats',
                                         'Purchase of emissions trading or gold, VAT deductible, regular rate'),
  ('92', 'reverse_charge', false, true,  'Kjøp av klimakvoter eller gull uten fradragsrett for mva, alminnelig sats',
                                         'Purchase of emissions trading or gold, without deduction of VAT, regular rate');

insert into vat_rate (code, valid_from, rate) values
  -- rateless and zero-rated
  ('0',  '1970-01-01', 0), ('7',  '1970-01-01', 0), ('20', '1970-01-01', 0),
  ('5',  '1970-01-01', 0), ('51', '1970-01-01', 0), ('52', '1970-01-01', 0),
  ('6',  '1970-01-01', 0), ('85', '1970-01-01', 0),
  -- 25 % alminnelig sats
  ('1',  '2022-01-01', 25), ('3',  '2022-01-01', 25), ('14', '2022-01-01', 25),
  ('21', '2022-01-01', 25), ('81', '2022-01-01', 25), ('82', '2022-01-01', 25),
  ('86', '2022-01-01', 25), ('87', '2022-01-01', 25), ('91', '2022-01-01', 25),
  ('92', '2022-01-01', 25),
  -- 15 % middels sats (food)
  ('11', '2022-01-01', 15), ('15', '2022-01-01', 15), ('22', '2022-01-01', 15),
  ('31', '2022-01-01', 15), ('83', '2022-01-01', 15), ('84', '2022-01-01', 15),
  -- 12 % lav sats (transport, accommodation, broadcasting, admission)
  ('13', '2022-01-01', 12), ('33', '2022-01-01', 12), ('88', '2022-01-01', 12),
  ('89', '2022-01-01', 12),
  -- 11.11 % råfisk
  ('12', '2022-01-01', 11.11), ('32', '2022-01-01', 11.11);
