package com.rokid.os.sprite.tts;

import android.os.Binder;
import android.os.IBinder;
import android.os.IInterface;
import android.os.Parcel;
import android.os.RemoteException;

public interface ITtsServer extends IInterface {
    String DESCRIPTOR = "com.rokid.os.sprite.tts.ITtsServer";

    void playTtsMsg(String text, String uuid, ITtsListener listener) throws RemoteException;

    void stopTtsPlay(String uuid) throws RemoteException;

    void updateTtsParam(String param) throws RemoteException;

    abstract class Stub extends Binder implements ITtsServer {
        private static final int TRANSACTION_PLAY_TTS_MSG = 1;
        private static final int TRANSACTION_STOP_TTS_PLAY = 2;
        private static final int TRANSACTION_UPDATE_TTS_PARAM = 3;

        public Stub() {
            attachInterface(this, DESCRIPTOR);
        }

        public static ITtsServer asInterface(IBinder binder) {
            if (binder == null) return null;
            IInterface local = binder.queryLocalInterface(DESCRIPTOR);
            if (local instanceof ITtsServer) return (ITtsServer) local;
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
            if (code == TRANSACTION_PLAY_TTS_MSG) {
                playTtsMsg(data.readString(), data.readString(), ITtsListener.Stub.asInterface(data.readStrongBinder()));
                reply.writeNoException();
                return true;
            }
            if (code == TRANSACTION_STOP_TTS_PLAY) {
                stopTtsPlay(data.readString());
                reply.writeNoException();
                return true;
            }
            if (code == TRANSACTION_UPDATE_TTS_PARAM) {
                updateTtsParam(data.readString());
                reply.writeNoException();
                return true;
            }
            return super.onTransact(code, data, reply, flags);
        }

        private static final class Proxy implements ITtsServer {
            private final IBinder remote;

            Proxy(IBinder remote) {
                this.remote = remote;
            }

            @Override
            public IBinder asBinder() {
                return remote;
            }

            @Override
            public void playTtsMsg(String text, String uuid, ITtsListener listener)
                throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    data.writeString(text);
                    data.writeString(uuid);
                    data.writeStrongInterface(listener);
                    remote.transact(TRANSACTION_PLAY_TTS_MSG, data, reply, 0);
                    reply.readException();
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }

            @Override
            public void stopTtsPlay(String uuid) throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    data.writeString(uuid);
                    remote.transact(TRANSACTION_STOP_TTS_PLAY, data, reply, 0);
                    reply.readException();
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }

            @Override
            public void updateTtsParam(String param) throws RemoteException {
                Parcel data = Parcel.obtain();
                Parcel reply = Parcel.obtain();
                try {
                    data.writeInterfaceToken(DESCRIPTOR);
                    data.writeString(param);
                    remote.transact(TRANSACTION_UPDATE_TTS_PARAM, data, reply, 0);
                    reply.readException();
                } finally {
                    reply.recycle();
                    data.recycle();
                }
            }
        }
    }
}
