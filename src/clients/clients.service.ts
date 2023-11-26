import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { ClientProfile } from './entities/client.entity';
import { CreateClientProfileDto } from './dto/create-client.dto';

@Injectable()
export class ClientsService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ClientProfile)
    private readonly clientRepository: Repository<ClientProfile>,
  ) {}

  async createClientProfile(
    userId: string,
    client: CreateClientProfileDto,
  ): Promise<ClientProfile> {
    const existingClientProfile = await this.clientRepository.findOne({
      where: [{ email: client.email }, { phone: client.phone }],
    });

    if (existingClientProfile) {
      throw new ConflictException('Client profile already exists');
    }

    const user = await this.usersRepository.findOne({
      where: { id: userId },
    });

    const clientProfile = new ClientProfile();
    clientProfile.fullName = client.fullName;
    clientProfile.email = client.email;
    clientProfile.phone = client.phone;

    clientProfile.user = user;

    return this.clientRepository.save(clientProfile);
  }

  async getAllClientProfiles(userId: string): Promise<ClientProfile[]> {
    return this.clientRepository.find({
      where: { user: { id: userId } },
    });
  }

  async getClientById(clientId: string): Promise<ClientProfile> {
    const client = await this.clientRepository.findOne({
      where: { id: clientId },
    });

    if (!client) {
      throw new NotFoundException('Client not found');
    }

    return client;
  }
}
