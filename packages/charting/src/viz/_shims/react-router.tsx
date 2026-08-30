'use client';
import { useEffect, useState, type ReactNode } from 'react';
export const ClientOnly = ({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) => {
  const [m, setM] = useState(false);
  useEffect(() => setM(true), []);
  return <>{m ? children : fallback}</>;
};
