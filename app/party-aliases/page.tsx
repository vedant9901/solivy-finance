import { redirect } from 'next/navigation';

/**
 * Party Aliases is a tab inside the main finance workspace so it inherits
 * the normal responsive sidebar/drawer, organization context, and mode state.
 * Direct visits return to that workspace and select the requested tab.
 */
export default function PartyAliasesRoute() {
  redirect('/?tab=party-aliases');
}
