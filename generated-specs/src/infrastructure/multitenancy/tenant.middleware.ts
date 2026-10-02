import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { tenantLocalStorage } from './tenant.storage';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const tenantId = req.headers['x-tenant-id'] as string || 'default';
    
    // Wrap the request in the AsyncLocalStorage context
    tenantLocalStorage.run({ tenantId }, () => {
      next();
    });
  }
}
