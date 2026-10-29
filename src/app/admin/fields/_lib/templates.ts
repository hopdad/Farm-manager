/**
 * The CSV templates offered for download on the admin pages. The same header rows are the
 * committed files tools/import/templates/{seasons,parties}.csv (a unit test keeps them equal).
 */
import { PARTY_COLUMNS } from '../../../../../tools/import/parties-csv';
import { SEASON_COLUMNS } from '../../../../../tools/import/seasons-csv';

export const SEASONS_TEMPLATE_CSV = `${SEASON_COLUMNS.join(',')}\r\n`;
export const PARTIES_TEMPLATE_CSV = `${PARTY_COLUMNS.join(',')}\r\n`;
