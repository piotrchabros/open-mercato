export const ALL_ORGANIZATIONS_COOKIE_VALUE = '__all__'
export const ORGANIZATION_MANAGE_APP_URL_FEATURE = 'directory.organizations.manage_app_url'

export function isAllOrganizationsSelection(value: string | null | undefined): boolean {
  return value === ALL_ORGANIZATIONS_COOKIE_VALUE
}
