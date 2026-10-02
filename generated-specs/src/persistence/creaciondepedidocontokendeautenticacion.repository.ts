import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreacionDePedidoConTokenDeAutenticacion } from '@prisma/client';

@Injectable()
export class CreacionDePedidoConTokenDeAutenticacionRepository {
  constructor(private prisma: PrismaService) {}

  async findById(id: string): Promise<CreacionDePedidoConTokenDeAutenticacion | null> {
    return this.prisma.creacionDePedidoConTokenDeAutenticacion.findUnique({ where: { id } });
  }

  async save(data: Omit<CreacionDePedidoConTokenDeAutenticacion, 'id' | 'createdAt' | 'updatedAt'>): Promise<CreacionDePedidoConTokenDeAutenticacion> {
    return this.prisma.creacionDePedidoConTokenDeAutenticacion.create({
      data,
    });
  }

  async delete(id: string): Promise<void> {
    await this.prisma.creacionDePedidoConTokenDeAutenticacion.delete({ where: { id } });
  }
}
