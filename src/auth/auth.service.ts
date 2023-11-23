import * as cookie from 'cookie';
import * as bcrypt from 'bcrypt';
import { totp } from 'otplib';
import RedisClient from '../utils/redis';
import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { CreateUserDto } from '../users/dto/create-user.dto';
import { UsersService } from '../users/users.service';
import { Payload } from './auth.type';
import { User } from '../users/entities/user.entity';

@Injectable()
export class AuthService {
  totp: typeof totp;
  cache: RedisClient;
  constructor(
    private usersService: UsersService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {
    this.cache = new RedisClient();
    this.totp = totp;
    this.totp.options = { digits: 6, step: 300 };
  }

  async signup(user: CreateUserDto) {
    const userExists = await this.usersService.findByEmail(user.email);

    if (userExists) {
      throw new ConflictException('User already exists');
    }

    user.password = await this.hashPassword(user.password);
    const newUser = await this.usersService.create(user);
    newUser.password = undefined;

    return newUser;
  }

  async signin(user: Partial<User>) {
    const [accessToken, refreshToken] = await this.getTokens(user);
    const cookieSerialized = this.setCookies(accessToken);
    await this.setCurrentRefreshToken(refreshToken, user.id);
    return { tokens: { accessToken, refreshToken }, cookie: cookieSerialized };
  }

  async signout(reqUser: Partial<User>, token: string) {
    try {
      const { user } = JSON.parse(JSON.stringify(reqUser));
      if (!user || !token) {
        throw new NotFoundException('User not found');
      }
      const updatedUser = { refreshToken: null };
      await this.usersService.update(user.id, updatedUser);
      await this.revokeToken(token);
      return true;
    } catch (error) {
      throw new InternalServerErrorException();
    }
  }

  public async forgotPassword(email: string): Promise<{ otp: string }> {
    await this.validateEmail(email);
    const user = await this.usersService.findByEmail(email.toLowerCase());

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const otp = await this.generateResetPasswordOtp();
    const otpKey = `${user.id}:otp`;

    if (await this.cache.exists(otpKey)) {
      await this.cache.del(otpKey);
    }
    await this.cache.set(otpKey, otp, 300);

    return { otp };
  }

  public async resetPassword(email: string, otp: string, newPassword: string) {
    await this.validateEmail(email);

    const user = await this.usersService.findByEmail(email.toLowerCase());
    await this.verifyResetPasswordOtp(otp, user.id);

    const updatedUser = { password: await this.hashPassword(newPassword) };
    return await this.usersService.update(user.id, updatedUser);
  }

  private async hashPassword(password: string): Promise<string> {
    if (!password) {
      throw new Error('Password is required for hashing.');
    }
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
  }

  private async comparePassword(
    password: string,
    hashedPassword: string,
  ): Promise<boolean> {
    return await bcrypt.compare(password, hashedPassword);
  }

  public async validateUser(email: string, password: string) {
    const user = await this.usersService.findByEmail(email);

    if (user && (await this.comparePassword(password, user.password))) {
      user.password = undefined;
      return user;
    }

    return null;
  }

  public async createAccessTokenFromRefreshToken(refreshToken: string) {
    try {
      const decoded = this.jwtService.decode(refreshToken) as Payload;
      if (!decoded) {
        throw new NotFoundException('Invalid token');
      }

      const user = await this.usersService.findOne(decoded.sub);
      if (!user) {
        throw new NotFoundException('User not found');
      }

      const isRefreshTokenMatched = await bcrypt.compare(
        refreshToken,
        user.refreshToken,
      );
      if (!isRefreshTokenMatched) {
        throw new NotFoundException('Invalid token');
      }

      const [accessToken] = await this.getTokens(user);

      return { accessToken };
    } catch (error) {
      throw new NotFoundException('Invalid token');
    }
  }

  async revokeToken(tokenId: string) {
    await this.cache.sadd('revokedToken', tokenId);
  }

  async isTokenRevoked(tokenId: string) {
    return await this.cache.sismember('revokedToken', tokenId);
  }

  getTokenOption(type: string): JwtSignOptions {
    const options: JwtSignOptions = {
      secret: this.configService.get(`${type}_secret`),
      expiresIn: this.configService.get(`${type}_expiresIn`),
    };

    return options;
  }

  async getTokens(user: Partial<User>) {
    const payload: Payload = { sub: user.id, role: user.role };

    const [accessToken, refreshToken] = await Promise.all([
      await this.jwtService.signAsync(payload, this.getTokenOption('access')),
      await this.jwtService.signAsync(payload, this.getTokenOption('refresh')),
    ]);

    return [accessToken, refreshToken];
  }

  async setCurrentRefreshToken(refreshToken: string, userId: string) {
    const hashedRefreshToken = await bcrypt.hash(refreshToken, 10);

    const updatedUser = { refreshToken: hashedRefreshToken };
    await this.usersService.update(userId, updatedUser);
  }

  public async generateResetPasswordOtp(): Promise<string> {
    return this.totp.generate(this.configService.get('otp_secret'));
  }

  private setCookies(token: string): string {
    return cookie.serialize('Bearer', token, {
      httpOnly: true,
      secure: this.configService.get('env') === 'production',
      sameSite: true,
      maxAge: 3600,
      path: '/',
    });
  }

  public async verifyResetPasswordOtp(otp: string, userId: string) {
    const OTP_TOKEN_SECRET = this.configService.get('otp_secret');
    const isValid = this.totp.check(otp, OTP_TOKEN_SECRET);

    if (!isValid) {
      throw new NotFoundException('Invalid OTP or OTP has expired');
    }

    const otpKey = `${userId}:otp`;
    const otpCached = await this.cache.get(otpKey);
    if (otpCached !== otp) {
      throw new NotFoundException('Invalid OTP');
    }

    await this.cache.del(otpKey);
  }

  private async validateEmail(email: string) {
    const emailRegex = '^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,4}$';
    if (!email.match(emailRegex)) {
      throw new NotFoundException('Invalid email');
    }
  }
}