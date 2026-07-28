export default function Home() {
  return (
    <main className="p-8">
      <h1 className="text-4xl font-bold">Marketing Agency OS</h1>
      <p className="text-lg mt-4">CRM + Email Outreach + Social Content Platform</p>
      <div className="grid grid-cols-2 gap-4 mt-8">
        <a href="/leads" className="p-6 border rounded-lg hover:bg-gray-100">📋 Leads</a>
        <a href="/outreach" className="p-6 border rounded-lg hover:bg-gray-100">📧 Outreach</a>
        <a href="/content" className="p-6 border rounded-lg hover:bg-gray-100">📱 Content</a>
        <a href="/campaigns" className="p-6 border rounded-lg hover:bg-gray-100">📊 Campaigns</a>
      </div>
    </main>
  );
}