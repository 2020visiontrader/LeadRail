import { useState, useEffect } from 'react';
import DataTable from '@/components/DataTable';
import ContactDrawer from '@/components/ContactDrawer';
import SearchInput from '@/components/SearchInput';
import FilterBar from '@/components/FilterBar';
import { Contact } from '@/lib/types';

export default function LeadsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');

  useEffect(() => {
    async function fetchContacts() {
      try {
        const params = new URLSearchParams({
          brandId: 'rentahub', // Default to first brand
          limit: '30',
          page: '0'
        });
        const res = await fetch(`/api/leads?${params}`);
        const data = await res.json();
        setContacts(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Failed to fetch contacts:', error);
      } finally {
        setIsLoading(false);
      }
    }

    fetchContacts();
  }, []);

  const filtered = contacts.filter((c) => {
    const matchesSearch = c.name.toLowerCase().includes(search.toLowerCase()) ||
                         c.email.toLowerCase().includes(search.toLowerCase()) ||
                         (c.company?.toLowerCase() || '').includes(search.toLowerCase());
    const matchesSegment = !segmentFilter || c.segment === segmentFilter;
    return matchesSearch && matchesSegment;
  });

  const handleRowClick = (contact: Contact) => {
    setSelectedContact(contact);
    setDrawerOpen(true);
  };

  const handleUpdate = async (contact: Contact) => {
    try {
      await fetch(`/api/leads/${contact.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contact)
      });
      setContacts(contacts.map(c => c.id === contact.id ? contact : c));
    } catch (error) {
      console.error('Failed to update contact:', error);
    }
  };

  return (
    <main className="p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold">Leads</h1>
          <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700">
            + Add Lead
          </button>
        </div>

        <div className="space-y-4 mb-6">
          <SearchInput
            placeholder="Search by name, email, or company..."
            value={search}
            onChange={setSearch}
          />
          <FilterBar
            segments={['investor', 'vc', 'angel', 'founder', 'media', 'partner', 'other']}
            selectedSegment={segmentFilter}
            onSegmentChange={setSegmentFilter}
          />
        </div>

        <div className="mb-4 text-sm text-gray-600">
          Showing {filtered.length} of {contacts.length} contacts
        </div>

        <DataTable
          contacts={filtered}
          isLoading={isLoading}
          onRowClick={handleRowClick}
        />

        <ContactDrawer
          contact={selectedContact}
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          onUpdate={handleUpdate}
        />
      </div>
    </main>
  );
}