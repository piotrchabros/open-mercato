import { SlaAdminForm } from '../../../../../components/SlaAdminForm'
export default function Page({ params }: { params?: { id?: string } }) { return <SlaAdminForm kind="policy" mode="edit" recordId={typeof params?.id === 'string' ? params.id : ''} /> }
