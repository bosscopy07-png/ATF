import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models/User';

export interface AuthenticatedRequest extends Request {
  adminUser?: any;
}

export async function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, config.adminSessionSecret) as any;
    const user = await User.findOne({ telegramId: decoded.telegramId });

    if (!user || (!user.isAdmin && !user.isSuperAdmin)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    req.adminUser = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

export function requireSuperAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (!req.adminUser?.isSuperAdmin) {
    res.status(403).json({ error: 'Super Admin required' });
    return;
  }
  next();
}
