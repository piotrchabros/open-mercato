export const features = [
  { id: 'webhook_calcom.manage', title: 'Manage Cal.com integration', module: 'webhook_calcom' },
  { id: 'webhook_calcom.transcripts.view', title: 'View unassigned Cal.com transcripts', module: 'webhook_calcom' },
  {
    id: 'webhook_calcom.transcripts.manage',
    title: 'Assign and dismiss unassigned Cal.com transcripts',
    module: 'webhook_calcom',
    dependsOn: ['webhook_calcom.transcripts.view'],
  },
]

export default features
