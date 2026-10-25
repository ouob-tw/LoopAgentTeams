# Run by browser-launch.test.ts on a private session bus, not a test itself: owns the Secret Service name
# and answers nothing, standing in for a keyring that is slow or stuck.
import dbus
import dbus.lowlevel
import dbus.mainloop.glib
from gi.repository import GLib

dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
bus.request_name('org.freedesktop.secrets')
bus.add_message_filter(lambda connection, message: dbus.lowlevel.HANDLER_RESULT_HANDLED)
print('ready', flush=True)
GLib.MainLoop().run()
