import { AsyncLocalStorage } from 'async_hooks';

export const tenantLocalStorage = new AsyncLocalStorage<{ tenantId: string }>();

/** The tenant of the current request (set by JwtTenantGuard). There is no default tenant. */
export function currentTenant(): string {
  const tenantId = tenantLocalStorage.getStore()?.tenantId;
  if (!tenantId) throw new Error('No tenant in the current context: the request was not authenticated');
  return tenantId;
}
