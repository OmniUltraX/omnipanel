use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Serial port info for device scanning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortInfo {
    pub port_name: String,
    pub port_type: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    pub serial_number: Option<String>,
    pub manufacturer: Option<String>,
}

/// Configuration for opening a serial port.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerialConfig {
    pub port_name: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub flow_control: String,
}

/// A handle to an open serial port with a reader thread.
pub struct SerialSession {
    port: Box<dyn serialport::SerialPort>,
}

impl SerialSession {
    pub fn open(config: &SerialConfig) -> Result<Self, String> {
        use serialport::{DataBits, FlowControl, Parity, StopBits};

        let data_bits = match config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            8 => DataBits::Eight,
            _ => return Err(format!("Invalid data bits: {}", config.data_bits)),
        };

        let stop_bits = match config.stop_bits {
            1 => StopBits::One,
            2 => StopBits::Two,
            _ => return Err(format!("Invalid stop bits: {}", config.stop_bits)),
        };

        let parity = match config.parity.as_str() {
            "None" => Parity::None,
            "Even" => Parity::Even,
            "Odd" => Parity::Odd,
            _ => return Err(format!("Invalid parity: {}", config.parity)),
        };

        let flow_control = match config.flow_control.as_str() {
            "None" => FlowControl::None,
            "RTS/CTS" => FlowControl::Hardware,
            "XON/XOFF" => FlowControl::Software,
            _ => return Err(format!("Invalid flow control: {}", config.flow_control)),
        };

        let port = serialport::new(&config.port_name, config.baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity)
            .flow_control(flow_control)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(|e| format!("Failed to open serial port: {e}"))?;

        Ok(Self { port })
    }

    pub fn write(&mut self, data: &[u8]) -> Result<usize, String> {
        self.port
            .write(data)
            .map_err(|e| format!("Serial write failed: {e}"))
    }

    pub fn read_into(&mut self, buf: &mut [u8]) -> Result<usize, String> {
        self.port
            .read(buf)
            .map_err(|e| format!("Serial read failed: {e}"))
    }

    pub fn set_dtr(&mut self, level: bool) -> Result<(), String> {
        self.port
            .write_data_terminal_ready(level)
            .map_err(|e| format!("Set DTR failed: {e}"))
    }

    pub fn set_rts(&mut self, level: bool) -> Result<(), String> {
        self.port
            .write_request_to_send(level)
            .map_err(|e| format!("Set RTS failed: {e}"))
    }
}

/// Scan for available serial ports on the system.
pub fn scan_ports() -> Result<Vec<PortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| format!("Port scan failed: {e}"))?;

    let result: Vec<PortInfo> = ports
        .into_iter()
        .map(|p| {
            let (port_type, vid, pid, serial, mfr) = match &p.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    "USB".to_string(),
                    Some(info.vid),
                    Some(info.pid),
                    info.serial_number.clone(),
                    info.manufacturer.clone(),
                ),
                serialport::SerialPortType::BluetoothPort => {
                    ("Bluetooth".to_string(), None, None, None, None)
                }
                serialport::SerialPortType::PciPort => {
                    ("PCI".to_string(), None, None, None, None)
                }
                _ => ("Unknown".to_string(), None, None, None, None),
            };

            PortInfo {
                port_name: p.port_name,
                port_type,
                vendor_id: vid,
                product_id: pid,
                serial_number: serial,
                manufacturer: mfr,
            }
        })
        .collect();

    Ok(result)
}

/// Shared state for all serial port sessions.
pub type SerialSessions = Arc<Mutex<HashMap<String, SerialSession>>>;
