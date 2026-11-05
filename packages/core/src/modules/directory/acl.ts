export const features = [
    { id: 'directory.tenants.view', title: 'View tenants', module: 'directory' },
    {
        id: 'directory.tenants.manage',
        title: 'Manage tenants',
        module: 'directory',
        dependsOn: ['directory.tenants.view'],
    },
    { id: 'directory.organizations.view', title: 'View organizations', module: 'directory' },
    {
        id: 'directory.organizations.manage',
        title: 'Manage organizations',
        module: 'directory',
        dependsOn: ['directory.organizations.view'],
    },
    {
        id: 'directory.organizations.manage_app_url',
        title: 'Manage organization address',
        module: 'directory',
        dependsOn: ['directory.organizations.manage'],
    },
]

export default features
