import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { tenantFromAuthorization } from './jwt';
import { tenantLocalStorage } from '../infrastructure/multitenancy/tenant.storage';

/** Rejects requests without a valid token carrying a tenant; exposes the tenant as request.tenantId. */
@Injectable()
export class JwtTenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; tenantId?: string }>();
    const tenantId = tenantFromAuthorization(request.headers.authorization);
    if (!tenantId) throw new UnauthorizedException('A valid bearer token with a tenant is required');
    request.tenantId = tenantId;
    // Tenant-scoped Prisma queries (PrismaService.tenant) read it from here.
    tenantLocalStorage.enterWith({ tenantId });
    return true;
  }
}
