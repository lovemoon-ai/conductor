package com.rokid.os.sprite.tts;

import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;
import android.os.Parcel;
import android.os.RemoteException;

public interface ITtsListener extends IInterface {
    String DESCRIPTOR = "com.rokid.os.sprite.tts.ITtsListener";

    void onTtsStart(String uuid) throws RemoteException;

    void onTtsStop(String uuid) throws RemoteException;

    abstract class Stub extends Binder implements ITtsListener {
        private static final int TRANSACTION_ON_TTS_START = 1;
        private static final int TRANSACTION_ON_TTS_STOP = 2;

        public Stub() {
            attachInterface(this, DESCRIPTOR);
        }

        public static ITtsListener asInterface(IBinder binder) {
            if (binder == null) return null;
            IInterface local = binder.queryLocalInterface(DESCRIPTOR);
            if (local instanceof ITtsListener) return (ITtsListener) local;
            return new Proxy(binder);
        }

        @Override
        public IBinder asBinder() {
            return this;
        }

        @Override
        protected boolean onTransact(int code, Parcel data, Parcel reply, int flags)
            throws RemoteException {
            if (code >= 1 && code <= 16777215) {
                data.enforceInterface(DESCRIPTOR);
            }
            if (code == INTERFACE_TRANSACTION) {
                reply.writeString(DESCRIPTOR);
                return true;
            }
            if (code == TRANSACTION_ON_TTS_START) {
                onTtsStart(data.readString());
                reply.writeNoException();
                return true;
            }
            if (code == TRANSACTION_ON_TTS_STOP) {
                onTtsStop(data.readString());
                reply.writeNoException();
                return true;
            }
            return super.onTransact(code, data, reply, flags);
        }

        private static final class Proxy implements ITtsListener {
            private final IBinder remote;

            Proxy(IBinder remote) {
                this.remote = remote;
            }

            @Override
            public IBinder asBinder() {
                return remote;
            }

            @Override
            public void onTtsStart(String uuid) throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    data.writeString(uuid);
                    remote.transact(TRANSACTION_ON_TTS_START, data, reply, 0);
                    reply.readException();
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }

            @Override
            public void onTtsStop(String uuid) throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    data.writeString(uuid);
                    remote.transact(TRANSACTION_ON_TTS_STOP, data, reply, 0);
                    reply.readException();
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }
        }
    }
}
