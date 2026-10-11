import Foundation
import Security
import CryptoKit
import LocalAuthentication

// Keep the existing service/account names so prior OpenNova authorizations remain usable.
// Secrets travel only over process pipes.
func key() throws -> SymmetricKey {
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "OpenNova.SIWC.Probe", kSecAttrAccount as String: "encryption-v1"]
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    let context = LAContext()
    context.interactionNotAllowed = true
    lookup[kSecUseAuthenticationContext as String] = context
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecSuccess, let data = result as? Data, data.count == 32 {
        return SymmetricKey(data: data)
    }
    guard status == errSecItemNotFound else { throw NSError(domain: "Keychain", code: Int(status)) }
    var data = Data(count: 32)
    let randomStatus = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
    guard randomStatus == errSecSuccess else { throw NSError(domain: "Random", code: Int(randomStatus)) }
    var add = query
    add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    guard addStatus == errSecSuccess else { throw NSError(domain: "Keychain", code: Int(addStatus)) }
    return SymmetricKey(data: data)
}

do {
    let operation = CommandLine.arguments.dropFirst().first ?? "check"
    let encryptionKey = try key()
    if operation == "check" {
        print("available")
    } else {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let output: Data
        if operation == "encrypt" {
            output = try AES.GCM.seal(input, using: encryptionKey).combined!
        } else if operation == "decrypt" {
            output = try AES.GCM.open(AES.GCM.SealedBox(combined: input), using: encryptionKey)
        } else { throw NSError(domain: "Operation", code: 1) }
        FileHandle.standardOutput.write(output)
    }
} catch {
    FileHandle.standardError.write(Data("Secure storage operation failed: \((error as NSError).domain) \((error as NSError).code)\n".utf8))
    exit(1)
}
