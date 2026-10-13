import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { currentTenant } from '../infrastructure/multitenancy/tenant.storage';
import type { CreacionDePedidoConTokenDeAutenticacion } from '@prisma/client';

@Injectable()
export class CreacionDePedidoConTokenDeAutenticacionRepository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<CreacionDePedidoConTokenDeAutenticacion | null> {
    return this.prisma.tenant.creacionDePedidoConTokenDeAutenticacion.findUnique({ where: { id } });
  }

  /** Creates a row for the tenant of the authenticated request (never a default tenant). */
  async save(data: Omit<CreacionDePedidoConTokenDeAutenticacion, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<CreacionDePedidoConTokenDeAutenticacion> {
    return this.prisma.tenant.creacionDePedidoConTokenDeAutenticacion.create({
      data: { ...data, tenantId: currentTenant() },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.tenant.creacionDePedidoConTokenDeAutenticacion.delete({ where: { id } });
  }
}
