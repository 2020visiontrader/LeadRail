export default function Settings() {
  return (
    <main className="p-8">
      <h1 className="text-3xl font-bold">Settings</h1>
      <p className="text-gray-600 mt-2">Integration Management Hub</p>
      <div className="mt-8 grid grid-cols-3 gap-4">
        <div className="p-4 border rounded-lg">
          <h3 className="font-semibold">Brevo</h3>
          <p className="text-sm text-gray-600">Email Platform</p>
        </div>
        <div className="p-4 border rounded-lg">
          <h3 className="font-semibold">Postiz</h3>
          <p className="text-sm text-gray-600">Social Media</p>
        </div>
        <div className="p-4 border rounded-lg">
          <h3 className="font-semibold">Meta</h3>
          <p className="text-sm text-gray-600">Facebook & Instagram</p>
        </div>
      </div>
    </main>
  );
}