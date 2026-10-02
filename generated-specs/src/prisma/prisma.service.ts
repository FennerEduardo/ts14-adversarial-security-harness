import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { tenantLocalStorage } from '../infrastructure/multitenancy/tenant.storage';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  constructor() {
    super();
    this.addTenantMiddleware();
  }

  async onModuleInit() {
    await this.$connect();
  }

  private addTenantMiddleware() {
    // Prisma $use middleware for automatic tenant filtering
    this.$use(async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<unknown>) => {
      const context = tenantLocalStorage.getStore();
      const tenantId = context?.tenantId || 'default';

      // Check if the model has a tenantId field (assume yes for demo, adjust as needed)
      // For a real production app, you might want a whitelist of tenant-aware models
      if (params.model && !['OutboxMessage', 'ProcessedEvent', 'SagaInstance'].includes(params.model)) {
        if (params.action === 'findUnique' || params.action === 'findFirst') {
          // Change to findFirst
          params.action = 'findFirst';
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'findMany') {
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'update' || params.action === 'updateMany' || params.action === 'delete' || params.action === 'deleteMany') {
          params.args.where = { ...params.args.where, tenantId };
        }
        if (params.action === 'create' || params.action === 'createMany') {
          if (params.action === 'create') {
            params.args.data = { ...params.args.data, tenantId };
          } else {
            params.args.data = params.args.data.map((d: any) => ({ ...d, tenantId }));
          }
        }
      }
      return next(params);
    });
  }
}
