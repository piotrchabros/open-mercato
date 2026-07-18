import { z } from 'zod'
import { makeCrudRoute } from '@open-mercato/shared/lib/crud/factory'
import { resolveCrudRecordId } from '@open-mercato/shared/lib/api/scoped'
import { resolveTranslations } from '@open-mercato/shared/lib/i18n/server'
import { CrudHttpError } from '@open-mercato/shared/lib/crud/errors'
import { Routing } from '../../data/entities.js'
import {
  routingCreateSchema,
  routingUpdateSchema,
  routingListQuerySchema,
  routingOperationInputSchema,
} from '../../data/validators.js'
import { E } from '../../../../../generated/entities.ids.generated.js'
import {
  createManufacturingCrudOpenApi,
  createPagedListResponseSchema,
  defaultOkResponseSchema,
} from '../openapi.js'

const rawBodySchema = z.object({}).passthrough()

const routeMetadata = {
  GET: { requireAuth: true, requireFeatures: ['manufacturing.technology.view'] },
  POST: { requireAuth: true, requireFeatures: ['manufacturing.technology.manage'] },
  PUT: { requireAuth: true, requireFeatures: ['manufacturing.technology.manage'] },
  DELETE: { requireAuth: true, requireFeatures: ['manufacturing.technology.manage'] },
}

export const metadata = routeMetadata

const crud = makeCrudRoute({
  metadata: routeMetadata,
  orm: {
    entity: Routing,
    idField: 'id',
    orgField: 'organizationId',
    tenantField: 'tenantId',
    softDeleteField: 'deletedAt',
  },
  indexer: { entityType: E.manufacturing.routing },
  list: {
    entityId: E.manufacturing.routing,
    schema: routingListQuerySchema,
    fields: ['id', 'product_id', 'variant_id', 'version', 'status', 'name', 'created_at', 'updated_at'],
    sortFieldMap: {
      name: 'name',
      version: 'version',
      status: 'status',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    },
    transformItem: (item: Record<string, unknown>) => {
      if (!item) return item
      return {
        id: item.id,
        productId: item.product_id,
        variantId: item.variant_id,
        version: item.version,
        status: item.status,
        name: item.name,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      }
    },
  },
  actions: {
    create: {
      commandId: 'manufacturing.routings.create',
      schema: rawBodySchema,
      mapInput: async ({ raw }) => routingCreateSchema.parse(raw),
      response: ({ result }) => ({ id: result?.id ?? null }),
      status: 201,
    },
    update: {
      commandId: 'manufacturing.routings.update',
      schema: rawBodySchema,
      mapInput: async ({ raw }) => routingUpdateSchema.parse(raw),
      response: () => ({ ok: true }),
    },
    delete: {
      commandId: 'manufacturing.routings.delete',
      schema: rawBodySchema,
      mapInput: async ({ parsed, ctx }) => {
        const { translate } = await resolveTranslations()
        const id = resolveCrudRecordId(parsed, ctx, translate)
        if (!id) {
          throw new CrudHttpError(400, { error: translate('manufacturing.errors.id_required', 'Record id is required') })
        }
        return { id }
      },
      response: () => ({ ok: true }),
    },
  },
})

export const { GET, POST, PUT, DELETE } = crud

const routingListItemSchema = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable(),
  version: z.number(),
  status: z.enum(['draft', 'active', 'archived']),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const openApi = createManufacturingCrudOpenApi({
  resourceName: 'Routing',
  pluralName: 'Routings',
  querySchema: routingListQuerySchema,
  listResponseSchema: createPagedListResponseSchema(routingListItemSchema),
  create: {
    schema: routingCreateSchema.extend({ operations: z.array(routingOperationInputSchema) }),
    description: 'Creates a new routing version with its operations.',
  },
  update: {
    schema: routingUpdateSchema,
    responseSchema: defaultOkResponseSchema,
    description: 'Updates routing header fields and/or replaces its operations.',
  },
  del: {
    schema: z.object({ id: z.string().uuid() }),
    responseSchema: defaultOkResponseSchema,
    description: 'Soft-deletes a routing version by ID.',
  },
})
