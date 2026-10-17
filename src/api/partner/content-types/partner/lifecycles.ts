import { buildInviteUrl, generateInviteCode } from '../../../../utils/partner-invite';

// Nieuwe partners krijgen meteen een uitnodigingslink. Maak je in de admin het
// veld invite_code leeg en sla je op, dan wordt er een nieuwe link gemaakt (de
// oude werkt dan niet meer).
const ensureInvite = (data: Record<string, any> | undefined, isCreate: boolean) => {
  if (!data) return;

  if (isCreate ? !data.invite_code : 'invite_code' in data && !data.invite_code) {
    data.invite_code = generateInviteCode();
  }

  if (data.invite_code) {
    data.invite_url = buildInviteUrl(data.invite_code);
  }
};

export default {
  beforeCreate(event: any) {
    ensureInvite(event.params?.data, true);
  },
  beforeUpdate(event: any) {
    ensureInvite(event.params?.data, false);
  },
};
